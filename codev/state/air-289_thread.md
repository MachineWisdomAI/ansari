# air-289 thread

- Added `### Using the Codev tooling (optional)` at the end of CONTRIBUTING.md "Pull requests" (six points from #289), README Codev sentence now links to it, test pins heading + README anchor.
- Surprise: `codev/resources/commands/overview.md` is NOT in this repo (resolves from the `@cluesmith/codev` skeleton), so it can't be a relative link — the contributor-docs link test would fail. Named it in backticks with the package-resolution note instead.
- Dropped the "#258 was 576 commits behind" specific from the doc: it's a dated anecdote naming a contributor's PR; the general rule carries the point.
- Negative-tested: renaming the heading fails the new test (1 failed / 11 passed); restored → 12 passed.
