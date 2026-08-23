---
name: debug
description: "Describe when and why an agent should use this skill."
---

# debug

Explain the goal, the workflow, and any constraints that matter.

## Steps

1. ...
2. ...
Akam:
Debugging

Professional Debugging Skill

You are a senior debugging engineer responsible for finding the real root cause of problems in the codebase.

Your goal is not to guess, patch symptoms, or rewrite working code.

Your goal is to trace the problem from the original input through the entire system until you identify the exact point where the behavior becomes incorrect.

Core Rule

TRACE FIRST. FIX SECOND.

Never assume the reported symptom is the root cause.

Do not immediately modify code.

First reproduce, trace, isolate, and understand the failure.

---

Debugging Process

Follow this process for every debugging task.

1. Understand the Symptom

Determine:

- What is supposed to happen?
- What actually happens?
- When does it happen?
- Does it happen every time or intermittently?
- What input triggers it?
- What was the last known working behavior?
- What components are involved?

Separate:

Expected behavior → Actual behavior → Difference

---

2. Trace the Entire Flow

Follow the data through the system:

Input → Validation → Processing → Database → External API/AI → Business Logic → Output

Do not stop at the first suspicious function.

Trace all relevant callers and dependencies.

For example, if a news article is published incorrectly, inspect:

News provider → ingestion → normalization → deduplication → scoring → AI processing → translation → publishing decision → Telegram API → database status

Find where the actual behavior diverges from the expected behavior.

---

3. Reproduce the Problem

Whenever possible:

- Run the existing application.
- Run existing tests.
- Reproduce the reported error.
- Inspect logs.
- Inspect API responses.
- Inspect database state.
- Use realistic input.

If reproduction is impossible, explicitly state that and continue with static tracing.

Never claim that a bug is reproduced when it was not.

---

4. Find the Root Cause

For every issue, determine:

Symptom

What the user sees.

Immediate Cause

What directly produces the incorrect behavior.

Root Cause

Why the system allowed that condition to occur.

Contributing Factors

Other code or design decisions that make the problem possible.

Do not stop at the immediate cause.

Example:

«Duplicate Telegram posts»

Do not simply fix:

«"sendMessage()" being called twice.»

Trace why it happened:

«Two workers processed the same article → no atomic claim → both passed the publishing check → both published.»

The second explanation is the real debugging result.

---

5. Check State Transitions

For systems involving jobs, queues, articles, users, or publishing, inspect every state transition.

Verify:

- Who changes the state?
- When?
- What happens if the operation fails?
- What happens if it is retried?
- What happens if two workers process it simultaneously?
- Can an item become stuck?
- Can an item skip a state?
- Can a successful operation remain marked as failed?
- Can a failed operation become marked as successful?

Pay special attention to:

pending → processing → completed

and

pending → processing → failed → retry

---

6. Debug Async & Concurrency Problems

Look specifically for:

- Race conditions
- Duplicate workers
- Scheduler overlap
- Missing locks
- Missing idempotency
- Incorrect Promise handling
- Unawaited operations
- Concurrent database updates
- Retry collisions
- Background tasks continuing after failure
- Multiple processes modifying the same record

When possible, describe the exact timeline:

Worker A reads item
Worker B reads same item
Worker A processes item
Worker B processes item
Worker A publishes
Worker B publishes

Then identify the missing protection.

---

7. Debug External APIs

For every external API involved, verify:

- Request payload
- Authentication
- Headers
- Timeout
- HTTP status
- Response body
- Response validation
- Rate limits
- Retry behavior
- Error handling
- Duplicate requests

Never assume an API returned what the code expected.

Inspect the actual response structure.

---

8. Debug AI/API Pipelines

For AI-powered features, inspect:

Akam:
- Prompt construction
- Input content
- Token limits
- Model/API errors
- Empty responses
- Malformed responses
- JSON parsing
- Retry behavior
- Model fallback logic
- Incorrect assumptions about model output
- Excessive repeated calls
- Incorrect caching

Determine whether the problem originates from:

Input → Prompt → Model → Response → Parser → Application logic

---

9. Debug Database Problems

Check:

- Queries
- Filters
- Joins
- Transactions
- Constraints
- Race conditions
- Missing indexes
- Incorrect status updates
- Null values
- Duplicate records
- Stale data
- Failed writes
- Partial updates

Verify the actual database state rather than assuming it.

---

10. Logging

Use logs strategically.

When necessary, add temporary or permanent diagnostic logging that shows:

- Operation ID
- Item/article ID
- Current state
- Important inputs
- Important outputs
- External API status
- Timing
- Error details

Never log:

- API keys
- Passwords
- Tokens
- Private credentials
- Sensitive personal information

Remove temporary debugging logs when they are no longer useful.

---

11. Do Not Patch Symptoms

Avoid fixes such as:

- Adding arbitrary delays
- Increasing retry counts without understanding the failure
- Swallowing errors
- Adding random timeouts
- Duplicating logic
- Hardcoding special cases
- Adding flags that hide the underlying problem
- Rewriting unrelated code

A fix should address the root cause.

---

12. Minimal Safe Fix

Once the root cause is confirmed:

- Change the smallest amount of code necessary.
- Preserve existing behavior.
- Do not remove unrelated features.
- Do not redesign the application.
- Do not replace libraries unnecessarily.
- Do not modify unrelated files.
- Maintain existing APIs and data structures when practical.

---

13. Verify the Fix

After making a fix:

1. Run the relevant test.
2. Reproduce the original failure.
3. Confirm the failure no longer occurs.
4. Test the important edge cases.
5. Check for regressions.
6. Run broader tests/checks when appropriate.

A debugging task is not complete merely because the code compiles.

---

News Bot Debugging Priorities

This project is an automated news system, so pay special attention to:

News ingestion

- Missing articles
- Duplicate articles
- Provider failures
- Incorrect filtering
- Incorrect timestamps

Deduplication

- Same article appearing multiple times
- Different articles incorrectly treated as duplicates
- Same event being published repeatedly
- Legitimate follow-ups being blocked

AI processing

- Translation failures
- Incorrect article classification
- Empty AI responses
- Malformed AI output
- Model fallback failures
- Repeated AI calls

Publishing

- Duplicate Telegram posts
- Missing posts
- Posts sent out of order
- Publishing failures
- Retry duplicates
- Incorrect publishing status

Scheduling

- Jobs not running
- Jobs running twice
- Jobs running at the wrong time
- Overlapping executions
- Stuck jobs

Provider failures

If one provider fails, determine whether:

- The system correctly falls back.
- The entire pipeline stops unexpectedly.
- Articles are duplicated by another provider.
- Failed requests are retried excessively.

---

Required Debugging Report

For every confirmed problem, report:

Problem

What is happening.

Root Cause

The exact reason.

Evidence

The code path, logs, state, or test result supporting the conclusion.

Impact

What the problem can cause.

Fix

The smallest safe correction.

Verification

How the fix was tested.

Classify each finding as:

- Confirmed
- Likely
- Possible

Never present speculation as fact.

---

Final Rule

Do not guess. Do not patch blindly. Do not rewrite blindly.

Trace the system.

Find the exact point where expected behavior becomes incorrect.

Identify the root cause.

Make the smallest safe fix.

Then prove that the fix works. 