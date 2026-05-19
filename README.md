# GitHub Automatic Releases
[![GitHub latest release](https://img.shields.io/github/v/release/plu5/automatic-releases-with-sha-action?color=success&label=stable)](../../releases/latest)

This action simplifies the GitHub release process by automatically uploading assets, generating changelogs, handling pre-releases, and so on.

**Fork of [`marvinpinto/action-automatic-releases`](https://github.com/marvinpinto/action-automatic-releases)**. The differences in this fork are:

1. **Formatting changes:** Different changelog formatting (see [example release](https://github.com/plu5/testing-actions-github/releases/tag/v1.0.1))
2. **Artifact checksums:** In addition to the changelog, release notes have a section with the sha256 hashes of the artifacts if there are any (again, see [example release](https://github.com/plu5/testing-actions-github/releases/tag/v1.0.1))
3. **Annotated tags:** Use annotated tags instead of lightweight tags, with the ability to pass the tag annotation in new optional parameter `tag_annotation`
4. **Changelog to previous version tag:** Different behaviour with the parameter `automatic_release_tag`. In the original action if this parameter is provided, the changelog is generated between the given tag and the previous release with the same tag, resulting in an empty changelog if this is the first release with the given tag. I have changed it to generate the changelog between the given tag and previous tag, rather than the same tag: for example, between v1.0.0 and v1.0.1, rather than v1.0.1 and the previous v1.0.1 release. To get the old behaviour, use `is_tag_static: true`.
5. **Avoid double-linking PRs:** In PR commits, avoid adding a link to the PR if it's already in the commit summary ([like #5 or GH-5](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/autolinked-references-and-urls)) (in the original action we end up with the link appearing twice, like `fake change (#1) #1 — @plu5 in 706f6a3`. With this action, the second `#1` will not be added: `fake change (#1) — @plu5 in 706f6a3`).
6. **Commit type exclusions:** Parameter `excluded_types` for excluding commits of given Conventional Commits types. Example: `excluded_types: docs chore revert`
7. **Preamble:** Parameter `preamble` for markdown to prepend the changelog with, for optionally adding information before the generated list of changes. Tip: With workflow dispatch string inputs, you can modify in Github's HTML `input` to `textarea` with your browser inspector to be able to pass through multiline inputs.

## Contents

1. [Usage Examples](#usage-examples)
1. [Supported Parameters](#supported-parameters)
1. [Changelog Considerations](#changelog-considerations)
1. [Stable Versions](#stable-versions)
1. [License](#license)
1. [Ideas](#ideas)

## Usage Examples

### Workflow Dispatch

```yaml
name: Autorelease on workflow dispatch

on:
  workflow_dispatch:
    inputs:
      tag:
        type: string
        required: true
      annotation:
        type: string
        required: false

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - name: 1. Checkout
        uses: actions/checkout@v3

      - name: 2. Create some mock artifacts
        run: |
          mkdir dist
          echo "mock artifact 1" > ./dist/mockartifact1
          echo "mock artifact 2" > ./dist/mockartifact2
          echo "mock artifact 3" > ./dist/mockartifact3

      - name: 3. Release
        uses: plu5/automatic-releases-with-sha-action@main
        with:
          repo_token: ${{ secrets.GITHUB_TOKEN }}
          automatic_release_tag: ${{ inputs.tag }}
          tag_annotation: ${{ inputs.annotation }}
          prerelease: false
          files: ./dist/*
```

This is a workflow that will run when manually called from the repository’s Actions page, and will generate a release with a given tag (and optionally, tag annotation) and some artifacts.

### On Push to a Version File

\+ auto tag + auto annotation based on the commit message

```yaml
name: Autorelease on version bump

on:
  push:
    paths: ['VERSION.txt'] # VERSION_FILE

env:
  VERSION_FILE: 'VERSION.txt'

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - name: 1. Checkout
        uses: actions/checkout@v3

      - name: 2. Get version from file + annotation from commit message body
        run: |
          # Get version from file
          VERSION=$(cat $VERSION_FILE); VERSION=${VERSION%%[[:cntrl:]]}
          echo "VERSION=$VERSION" >> $GITHUB_ENV
          # Get commit message body
          echo "${{ github.event.head_commit.message }}" > commit_msg
          ANNOTATION=$(tail -n +3 commit_msg)
          echo -e "ANNOTATION<<EOF\n$ANNOTATION\nEOF" >> $GITHUB_ENV

      - name: 3. Release
        uses: plu5/automatic-releases-with-sha-action@main
        with:
          repo_token: ${{ secrets.GITHUB_TOKEN }}
          automatic_release_tag: v${{ env.VERSION }}
          tag_annotation: ${{ env.ANNOTATION }}
          prerelease: false
```

The idea here is to write in the commit message body of the commit in which you bump the version some description of the release, which will be used as the tag annotation. If none is provided, it will also work fine (empty tag annotation is allowed).

### On Tag Push

```yaml
name: "Autorelease on tag push"

on:
  push:
    tags:
      - "v*"

jobs:
  release:
    runs-on: "ubuntu-latest"
    steps:
      # ...
      - name: "Build & test"
        run: |
          echo "done!"

      - uses: "plu5/automatic-releases-with-sha-action@main"
        with:
          repo_token: "${{ secrets.GITHUB_TOKEN }}"
          prerelease: false
          files: |
            LICENSE.txt
            *.jar
```

If used on tag push, there is no need to manually pass the tag in `automatic_releases_tag`; it will be parsed from the git ref.

There are downsides to releasing on tag push:
- GitHub Actions cache does not get shared between different tags, so if you use caching in your workflow it will not be used
- It may cause some issues with certain GitHub actions that expect the git ref to not be a tag. For instance, actions/checkout will checkout the repository in a detached HEAD state, unless you pass it a different ref

## Supported Parameters

| Parameter               | Description                                                | Default  |
| ----------------------- | ---------------------------------------------------------- | -------- |
| `repo_token` (required) | GitHub Actions token; `"${{ secrets.GITHUB_TOKEN }}"`      | `null`   |
| `draft`                 | Mark this release as a draft?                              | `false`  |
| `prerelease`            | Mark this release as a pre-release?                        | `true`   |
| `automatic_release_tag` | Tag name to use for automatic releases                     | `null`   |
| `is_tag_static`         | Generate changelog from the same tag instead of previous, in case you use the same tag name every time (e.g. 'latest') | `false` |
| `tag_annotation`        | Optional tag annotation.                                   |  ""      |
| `title`                 | Release title; defaults to the tag name if none specified. | Tag Name |
| `files`                 | Files to upload as part of the release assets. Supports multi-line [glob](https://github.com/isaacs/node-glob) patterns. Split on newlines. | ""       |
| `excluded_types`        | Conventional Commits types to exclude from the changelog. Split on newlines and on spaces (e.g. `docs chore`). | ""       |
| `preamble`              | Markdown string to prepend to the changelog.               | `null`   |

## Outputs

The following output values can be accessed via `${{ steps.<step-id>.outputs.<output-name> }}`:

| Name                     | Description                                            | Type   |
| ------------------------ | ------------------------------------------------------ | ------ |
| `automatic_releases_tag` | The release tag this action just processed             | string |
| `upload_url`             | The URL for uploading additional assets to the release | string |

## Changelog Considerations

### SemVer

Unless `is_tag_static` is provided, the changelog is generated between this and the previous [semver-looking](https://semver.org/) tag. That means if your tags are not semver-looking and `is_tag_static` is false or not set, it will not be able to find the previous tag to generate a changelog from.

Allowing any tag might be unwanted, as some projects may be using some non-version tags but still expect the changelog to be between version tags only. So if the ability to generate a changelog between this and any previous tag is to be added, it should be optional (controlled by a parameter you can pass). Also may add a parameter to pass in the previous tag you want to generate a changelog from.

### Conventional Commits

The changelog generation splits commits into different subheadings based on their 'type' as defined in the [Conventional Commits specification](https://www.conventionalcommits.org/en/v1.0.0/).

Types and subheadings they get put under:
- feat → Features
- fix → Bug Fixes
- docs → Documentation
- style → Styles
  + [isn't this type supposed to be for linting commits? what is "Styles" even supposed to mean? maybe this subheading needs to be renamed to "Code Style"]
- refactor → Code Refactoring
- perf → Performance Improvements
- test → Tests
- build → Builds
- ci → Continuous Integration
- chore → Chores
- revert → Reverts

Additionally:
- Commits with no type → Miscellaneous
- Commits that are labelled as a breaking change → Breaking Changes

## Stable Versions

If you don't wish to live on the bleeding edge you may use a stable release instead. See [releases](../../releases) for the available versions.

```yaml
- uses: "plu5/automatic-releases-with-sha-action@<VERSION>"
```

## License

The source code for this project is released under the [MIT License](/LICENSE). This project is not associated with GitHub.

## Ideas
- [ ] regex exclusions
- [ ] preview somehow
- [ ] boolean option to exclude Miscellaneous (commits without types). kind of risky though, what if they misspelled the type in the commit summary?
- [ ] types headings customisation
