import * as core from '@actions/core';
import * as github from '@actions/github';
import {Context} from '@actions/github/lib/context';
import * as Octokit from '@octokit/rest';
import {sync as commitParser} from 'conventional-commits-parser';
import semverValid from 'semver/functions/valid';
import semverRcompare from 'semver/functions/rcompare';
import semverLt from 'semver/functions/lt';

import {getChangelogOptions, dumpGitHubEventPayload} from './utils';
import {isBreakingChange, generateChangelogFromParsedCommits, parseGitTag,
        ParsedCommits, appendFullChangelogLink, octokitLogger} from './utils';
import {getPaths} from './files';
import {getChecksums} from './sha';
import {uploadReleaseArtifacts} from './uploadReleaseArtifacts';

type Args = {
  repoToken: string;
  automaticReleaseTag: string;
  isTagStatic: boolean;
  draftRelease: boolean;
  preRelease: boolean;
  releaseTitle: string;
  tagAnnotation: string;
  files: string[];
  excludedTypes: string[];
  preamble: string;
};

const getAndValidateArgs = (): Args => {
  const args = {
    repoToken: core.getInput('repo_token', {required: true}),
    automaticReleaseTag: core.getInput('automatic_release_tag', {required: false}),
    isTagStatic: JSON.parse(core.getInput('is_tag_static', {required: false})),
    draftRelease: JSON.parse(core.getInput('draft', {required: true})),
    preRelease: JSON.parse(core.getInput('prerelease', {required: true})),
    releaseTitle: core.getInput('title', {required: false}),
    tagAnnotation: core.getInput('tag_annotation', {required: false}),
    files: [] as string[],
    excludedTypes: [] as string[],
    preamble: core.getInput('preamble', {required: false}),
  };

  const inputFilesStr = core.getInput('files', {required: false});
  if (inputFilesStr) {
    args.files = inputFilesStr.split(/\r?\n/);
  }

  const inputExcludedTypesStr = core.getInput('excluded_types', {required: false});
  if (inputExcludedTypesStr) {
    args.excludedTypes = inputExcludedTypesStr.split(/\r?\n| /);
  }

  return args;
};

const createReleaseTag = async (client: github.GitHub, refInfo: Octokit.GitCreateRefParams, message: string) => {
  core.startGroup('Generating release tag');
  const friendlyTagName = refInfo.ref.substring(10); // 'refs/tags/latest' => 'latest'
  core.info(`Attempting to create or update release tag "${friendlyTagName}"`);

  const tagResponse = await client.git.createTag({
    owner: refInfo.owner,
    repo: refInfo.repo,
    tag: friendlyTagName,
    message,
    object: refInfo.sha,
    type: 'commit',
  });
  refInfo.sha = tagResponse.data.sha;

  try {
    await client.git.createRef(refInfo);
  } catch (err) {
    const existingTag = refInfo.ref.substring(5); // 'refs/tags/latest' => 'tags/latest'
    core.info(
      `Could not create new tag "${refInfo.ref}" (${err.message}) therefore updating existing tag "${existingTag}"`,
    );
    await client.git.updateRef({
      ...refInfo,
      ref: existingTag,
      force: true,
    });
  }

  core.info(`Successfully created or updated the release tag "${friendlyTagName}"`);
  core.endGroup();
};

const deletePreviousGitHubRelease = async (client: github.GitHub, releaseInfo: Octokit.ReposGetReleaseByTagParams) => {
  core.startGroup(`Deleting GitHub releases associated with the tag "${releaseInfo.tag}"`);
  try {
    core.info(`Searching for releases corresponding to the "${releaseInfo.tag}" tag`);
    const resp = await client.repos.getReleaseByTag(releaseInfo);

    core.info(`Deleting release: ${resp.data.id}`);
    await client.repos.deleteRelease({
      owner: releaseInfo.owner,
      repo: releaseInfo.repo,
      release_id: resp.data.id,
    });
  } catch (err) {
    core.info(`Could not find release associated with tag "${releaseInfo.tag}" (${err.message})`);
  }
  core.endGroup();
};

const generateNewGitHubRelease = async (
  client: github.GitHub,
  releaseInfo: Octokit.ReposCreateReleaseParams,
): Promise<string> => {
  core.startGroup(`Generating new GitHub release for the "${releaseInfo.tag_name}" tag`);

  core.info('Creating new release');
  const resp = await client.repos.createRelease(releaseInfo);
  core.endGroup();
  return resp.data.upload_url;
};

// Only called if "is_tag_static" is false
const searchForPreviousReleaseTag = async (
  client: github.GitHub,
  currentReleaseTag: string,
  tagInfo: Octokit.ReposListTagsParams,
): Promise<string> => {
  const validSemver = semverValid(currentReleaseTag);
  if (!validSemver) {
    throw new Error(
      `Cannot find previous release tag because the tag does not appear to conform to semantic versioning.`,
    );
  }

  const listTagsOptions = client.repos.listTags.endpoint.merge(tagInfo);
  const tl = await client.paginate(listTagsOptions);

  const tagList = tl
    .map((tag) => {
      core.debug(`Currently processing tag ${tag.name}`);
      const t = semverValid(tag.name);
      return {
        ...tag,
        semverTag: t,
      };
    })
    .filter((tag) => tag.semverTag !== null)
    .sort((a, b) => semverRcompare(a.semverTag, b.semverTag));

  let previousReleaseTag = '';
  for (const tag of tagList) {
    if (semverLt(tag.semverTag, currentReleaseTag)) {
      previousReleaseTag = tag.name;
      break;
    }
  }

  return previousReleaseTag;
};

const getCommitsSinceRelease = async (
  client: github.GitHub,
  tagInfo: Octokit.GitGetRefParams,
  currentSha: string,
): Promise<Octokit.ReposCompareCommitsResponseCommitsItem[]> => {
  core.startGroup('Retrieving commit history');
  let resp;

  core.info('Determining state of the previous release');
  let previousReleaseRef = '' as string;
  core.info(`Searching for SHA corresponding to previous "${tagInfo.ref}" release tag`);
  try {
    resp = await client.git.getRef(tagInfo);
    previousReleaseRef = parseGitTag(tagInfo.ref);
  } catch (err) {
    core.info(
      `Could not find SHA corresponding to tag "${tagInfo.ref}" (${err.message}). Assuming this is the first release.`,
    );
    previousReleaseRef = 'HEAD';
  }

  core.info(`Retrieving commits between ${previousReleaseRef} and ${currentSha}`);
  try {
    resp = await client.repos.compareCommits({
      owner: tagInfo.owner,
      repo: tagInfo.repo,
      base: previousReleaseRef,
      head: currentSha,
    });
    core.info(
      `Successfully retrieved ${resp.data.commits.length} commits between ${previousReleaseRef} and ${currentSha}`,
    );
  } catch (err) {
    // istanbul ignore next
    core.warning(`Could not find any commits between ${previousReleaseRef} and ${currentSha}`);
  }

  let commits = [];
  if (resp?.data?.commits) {
    commits = resp.data.commits;
  }
  core.debug(`Currently ${commits.length} number of commits between ${previousReleaseRef} and ${currentSha}`);

  core.endGroup();
  return commits;
};

export const getChangelog = async (
  client: github.GitHub,
  owner: string,
  repo: string,
  commits: Octokit.ReposCompareCommitsResponseCommitsItem[],
  excludedTypes: string[],
): Promise<string> => {
  const parsedCommits: ParsedCommits[] = [];
  core.startGroup('Generating changelog');

  for (const commit of commits) {
    core.debug(`Processing commit: ${JSON.stringify(commit)}`);
    core.debug(`Searching for pull requests associated with commit ${commit.sha}`);
    const pulls = await client.repos.listPullRequestsAssociatedWithCommit({
      owner: owner,
      repo: repo,
      commit_sha: commit.sha,
    });
    if (pulls.data.length) {
      core.info(`Found ${pulls.data.length} pull request(s) associated with commit ${commit.sha}`);
    }

    const clOptions = await getChangelogOptions();
    const parsedCommitMsg = commitParser(commit.commit.message, clOptions);

    // istanbul ignore next
    if (parsedCommitMsg.merge) {
      core.debug(`Ignoring merge commit: ${parsedCommitMsg.merge}`);
      continue;
    }

    parsedCommitMsg.extra = {
      commit: commit,
      pullRequests: [],
      breakingChange: false,
    };

    parsedCommitMsg.extra.pullRequests = pulls.data.map((pr) => {
      return {
        number: pr.number,
        url: pr.html_url,
      };
    });

    parsedCommitMsg.extra.breakingChange = isBreakingChange({
      body: parsedCommitMsg.body,
      footer: parsedCommitMsg.footer,
    });
    core.debug(`Parsed commit: ${JSON.stringify(parsedCommitMsg)}`);
    parsedCommits.push(parsedCommitMsg);
    core.info(`Adding commit "${parsedCommitMsg.header}" to the changelog`);
  }

  const changelog = generateChangelogFromParsedCommits(parsedCommits, excludedTypes);
  core.debug('Changelog:');
  core.debug(changelog);

  core.endGroup();
  return changelog;
};

export const main = async (): Promise<void> => {
  try {
    const args = getAndValidateArgs();
    const context = new Context();

    // istanbul ignore next
    const client = new github.GitHub(args.repoToken, {
      baseUrl: process.env['JEST_MOCK_HTTP_PORT']
        ? `http://localhost:${process.env['JEST_MOCK_HTTP_PORT']}`
        : undefined,
      log: {
        debug: (...logArgs) => core.debug(octokitLogger(...logArgs)),
        info: (...logArgs) => core.debug(octokitLogger(...logArgs)),
        warn: (...logArgs) => core.warning(octokitLogger(...logArgs)),
        error: (...logArgs) => core.error(octokitLogger(...logArgs)),
      },
    });

    core.startGroup('Initializing the Automatic Releases action');
    dumpGitHubEventPayload();
    core.debug(`Github context: ${JSON.stringify(context)}`);
    core.endGroup();

    core.startGroup('Determining release tags');
    const releaseTag = args.automaticReleaseTag ? args.automaticReleaseTag : parseGitTag(context.ref);
    if (!releaseTag) {
      throw new Error(
        `The parameter "automatic_release_tag" was not set and this does not appear to be a GitHub tag event. (Event: ${context.ref})`,
      );
    }

    const repoInfo = {owner: context.repo.owner, repo: context.repo.repo};
    const repoInfoArr: [string, string] = [repoInfo.owner, repoInfo.repo];

    const previousReleaseTag = args.isTagStatic
      ? args.automaticReleaseTag
      : await searchForPreviousReleaseTag(client, releaseTag, repoInfo);
    core.endGroup();

    const commitsSinceRelease = await getCommitsSinceRelease(
      client,
      {
        ...repoInfo,
        ref: `tags/${previousReleaseTag}`,
      },
      context.sha,
    );

    let changelog = appendFullChangelogLink(
      await getChangelog(client, ...repoInfoArr, commitsSinceRelease, args.excludedTypes),
      ...repoInfoArr,
      previousReleaseTag,
      releaseTag
    );
    const artifactPaths = await getPaths(args.files);
    const checksums = await getChecksums(artifactPaths);

    if (args.automaticReleaseTag) {
      await createReleaseTag(client, {
        ...repoInfo,
        ref: `refs/tags/${args.automaticReleaseTag}`,
        sha: context.sha,
      }, args.tagAnnotation ? args.tagAnnotation : "");

      await deletePreviousGitHubRelease(client, {
        ...repoInfo,
        tag: args.automaticReleaseTag,
      });
    }

    const preamble = args.preamble ? args.preamble + '\n\n' : '';

    const releaseUploadUrl = await generateNewGitHubRelease(client, {
      ...repoInfo,
      tag_name: releaseTag,
      name: args.releaseTitle ? args.releaseTitle : releaseTag,
      draft: args.draftRelease,
      prerelease: args.preRelease,
      body: preamble + changelog + '\n\n' + checksums,
    });

    await uploadReleaseArtifacts(client, releaseUploadUrl, artifactPaths);

    core.debug(`Exporting environment variable AUTOMATIC_RELEASES_TAG with value ${releaseTag}`);
    core.exportVariable('AUTOMATIC_RELEASES_TAG', releaseTag);
    core.setOutput('automatic_releases_tag', releaseTag);
    core.setOutput('upload_url', releaseUploadUrl);
  } catch (error) {
    core.setFailed(error.message);
    throw error;
  }
};
