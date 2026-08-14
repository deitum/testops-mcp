---
'@deitum/testops-mcp': minor
---

Add `launch_test_results`: one page of a launch's test results, each with its name, status and test
case. The launch is verified against the configured project before the results are read, and
`deleted` selects active results by default or the deleted ones instead.
