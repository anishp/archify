# Gitgraph renderer

`render-gitgraph.mjs` draws a git commit graph from `schemas/gitgraph.schema.json`.

- **Lanes:** one per entry in `branches[]`, top to bottom. Lane height grows to
  fit the tallest tag/ref stack above and the label/message lines below.
- **Columns:** one per commit, in `commits[]` order, each as wide as its own
  label, message and pills. Columns are separated by a fixed text-free gap.
- **Links:** same-lane parents are straight lines. A lane change runs along one
  lane and bends only inside a column gap: right after the parent for a branch
  cut (the new lane is empty before its first commit), right before the child
  for a merge. Straight lines are drawn last so each lane keeps its colour.
  Cherry-picks are dashed and are not parents.
- **Marks:** filled dot (commit), ring (merge), red square (`highlight`),
  crossed dot (`reverse`). Tags are square pills; refs are round pills in the
  colour of the branch they name; `HEAD` is emphasised.
- **Checks:** `gitgraph/duplicate-branch`, `duplicate-id`, `unknown-branch`,
  `missing-commit`, `order`, `duplicate-tag`, `empty-branch`.

`--layout-json` prints lanes, commit columns and link routes (including each
bend's gap and whether a route runs over another commit) for tests and review.

Known limit: lanes are never reused, so history with many short-lived branches
grows tall.
