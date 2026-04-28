# Project Backlog CSV Templates

Use these CSV templates to bulk import your backlog data. Save the files as `.csv` and upload from the Project Backlog page.

## Feature ID Template

Download: [feature_template.csv](templates/feature_template.csv)

**Columns**
- `Feature ID`: Unique key for the feature or bug (e.g., `FEAT-101`).
- `Description`: Short description of the feature or bug.

**Example**
```
Feature ID,Description
FEAT-101,User can export reports
BUG-45,Fix login redirect issue
```

## User Story Template

Download: [userstory_template.csv](templates/userstory_template.csv)

**Columns**
- `Feature ID`: Must match an existing Feature ID in the backlog.
- `User Story`: Short name of the user story.
- `Size`: One of `XS`, `S`, `M` (points and days are auto-calculated).

**Example**
```
Feature ID,User Story,Size
FEAT-101,Add CSV export endpoint,M
FEAT-101,Design export settings UI,S
BUG-45,Add regression test for redirect,XS
```
