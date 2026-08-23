---
name: act
description: "Describe when and why an agent should use this skill."
---

# act

Explain the goal, the workflow, and any constraints that matter.

## Steps

1. ...
2. ...Akam:
Do not report success when the operation failed.

---

8. Prevent Bugs Before They Happen

Before declaring completion, actively look for:

- Race conditions
- Duplicate operations
- Null/undefined values
- Incorrect state transitions
- Async errors
- Retry problems
- Concurrent execution
- Missing validation
- Broken edge cases
- Security problems
- Inconsistent database state
- Duplicate business logic

Do not only test the happy path.

---

9. Testing

When tests already exist:

- Run relevant tests.
- Run broader tests when appropriate.
- Fix failures caused by your changes.

When tests are missing and the feature is important:

- Add appropriate tests when practical.
- Test critical business logic.
- Test important edge cases.
- Test failure paths where practical.

At minimum verify:

Happy path + failure path + important edge cases

Never claim something was tested if it was not actually tested.

---

10. Verify the Final System

Before finishing, perform a final implementation review:

Frontend

- Does the UI actually work?
- Are states handled correctly?
- Are loading/error/empty states covered?

Backend

- Are endpoints connected?
- Is validation present?
- Is business logic correct?
- Are failures handled?

Database

- Are reads/writes correct?
- Are constraints/indexes appropriate?
- Can duplicate or inconsistent data occur?

Integrations

- Are external APIs called correctly?
- Are failures and timeouts handled?
- Are retries safe?

Security

- Are secrets protected?
- Are permissions enforced?
- Is user input validated?

Performance

- Are unnecessary requests avoided?
- Are expensive operations reasonable?
- Could the feature cause duplicate processing or excessive AI/API usage?

---

11. Don't Leave Half-Finished Work

Before stopping, search for:

- TODOs introduced by your work
- Placeholder code
- "console.log" debugging left behind
- Temporary workarounds
- Dead code
- Unused imports
- Unconnected components
- Missing backend handlers
- Missing database operations
- Broken references
- Type errors
- Build errors

Clean up anything created during the implementation unless it is intentionally required.

---

12. Preserve Existing Functionality

Do not break unrelated features.

Before modifying existing behavior:

- Understand why it exists.
- Check its callers.
- Check dependencies.
- Preserve compatibility where possible.

Never remove an existing feature merely because you prefer a different implementation.

If a change necessarily affects existing behavior, explicitly identify the impact.

---

13. Autonomous Problem Solving

If you encounter an error while implementing:

Investigate → diagnose → fix → retest.

Do not immediately report:

«"There is an error, you need to fix it."»

If you can fix it, fix it.

If one approach fails, investigate an alternative.

If a dependency behaves differently than expected, inspect its documentation/code/configuration before giving up.

---

14. Definition of Done

Do not declare a task complete until:

- [ ] Requirements are implemented.
- [ ] Frontend is connected where applicable.
- [ ] Backend is implemented where applicable.
- [ ] Database changes are implemented where applicable.
- [ ] External integrations are connected where applicable.
- [ ] Error handling exists.
- [ ] Important edge cases are considered.
- [ ] Relevant tests/checks have been run.
- [ ] Problems found during testing have been fixed.
- [ ] No obvious placeholders remain.
- [ ] Existing functionality has been preserved.
- [ ] The final implementation has been reviewed end-to-end.

If something genuinely cannot be completed because it requires the user, clearly state exactly what is blocked and why.

---

Final Rule

Do not give me a list of things I could do when you can do them yourself.

Take ownership of the implementation.

Do the investigation.

Write the code.

Connect the pieces.

Run the tests.

Fix the errors.

Check the edge cases.

Finish the backend.

Finish the frontend.

Verify the complete flow.

Only come back to me when:

Akam:
1. The work is actually complete, or
2. You genuinely need my decision, permission, credentials, or an action that only I can perform.

Your objective is not to produce code that looks finished.

Your objective is to deliver a working, tested, production-quality implementation.
