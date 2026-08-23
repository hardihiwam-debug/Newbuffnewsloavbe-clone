---
name: design
description: "Describe when and why an agent should use this skill."
---

# design

Explain the goal, the workflow, and any constraints that matter.

## Steps

1. ...
2. ...Akam:
16. Components & Design System

Before creating new components, inspect existing ones.

Reuse components where appropriate.

Create a consistent system for:

- Buttons
- Inputs
- Selects
- Tabs
- Cards
- Tables
- Badges
- Dialogs
- Drawers
- Toasts
- Tooltips
- Navigation
- Empty states
- Loading states
- Error states

Avoid having five visually different versions of the same button.

---

17. State Design

Every important screen should consider:

Loading

What does the user see while data loads?

Empty

What happens when there is no data?

Error

What happens when something fails?

Success

How does the user know an operation succeeded?

Partial

What happens when only some data succeeds?

Offline / degraded

What happens when connectivity or an external service fails?

Do not design only the perfect-data state.

---

18. Newsroom-Specific UX

For a news platform, prioritize:

Information density

Show enough information for editors to make decisions quickly.

Scannability

Users should understand the situation without reading every article.

Story hierarchy

Clearly distinguish:

- Breaking
- Important
- Developing
- Normal
- Analysis
- Background

Source visibility

Make source and timestamp easy to identify.

Story relationships

Consider:

- Related stories
- Same-event grouping
- Timeline
- Follow-ups
- Developing story indicators

Editorial actions

Important actions should be fast:

- Publish
- Reject
- Edit
- Reprocess
- Retry
- View source
- View related stories

Avoid forcing users through unnecessary confirmation screens.

---

19. Mobile Design

Do not simply shrink desktop UI.

Determine:

- What actions are essential on mobile?
- What can move into menus?
- What needs bottom navigation?
- What should become a drawer?
- What information can be condensed?
- What should remain immediately visible?

Design mobile workflows intentionally.

---

20. Performance-Aware UI

Avoid expensive visual effects when they provide little value.

Consider:

- Blur cost
- Large shadows
- Excessive animation
- Huge images
- Complex charts
- Unnecessary re-renders
- Large DOM trees

A beautiful UI that feels slow is not a good UI.

---

21. Use Existing Libraries Intelligently

Inspect the project's existing UI libraries before introducing another one.

Consider appropriate libraries for:

- Component systems
- Icons
- Charts
- Tables
- Animation
- Typography
- Accessibility
- Command palettes

Do not introduce multiple overlapping component libraries without a strong reason.

Prefer consistency over collecting libraries.

---

22. Don't Follow Trends Blindly

When considering a trendy design, ask:

1. Does it improve usability?
2. Does it improve hierarchy?
3. Does it fit the product?
4. Is it accessible?
5. Is it performant?
6. Is it maintainable?
7. Will it still look good in two years?

If the answer is no, don't use it.

---

23. Creative Design Thinking

Look for opportunities such as:

- Faster workflows
- Keyboard shortcuts
- Command palettes
- Smart defaults
- Contextual actions
- Bulk actions
- Inline editing
- Intelligent filtering
- Saved views
- Personalized dashboards
- Progressive disclosure
- Contextual recommendations
- Automation
- Better visual feedback

Ask:

«"What would make an experienced user significantly faster?"»

and:

«"What would make a new user immediately understand this product?"»

---

24. Design Review Before Implementation

For significant UI changes, provide a concise design assessment:

Current UX

What works and what doesn't.

Recommended Direction

The best design style for this product.

Alternative Directions

2–4 realistic alternatives when useful.

Why

Why the recommended direction is better.

Design System

Typography, spacing, colors, surfaces, radius, shadows, icons, etc.

UX Improvements

Specific workflow improvements.

Implementation Plan

Which existing components/files should change.

Then implement when authorized.

---

25. Final Standard

The goal is not:

"Make it pretty."

The goal is:

"Make it obvious, fast, beautiful, useful, accessible, consistent, and enjoyable."

Akam:
Every design decision should have a reason.

Use trends selectively.

Use psychology responsibly.

Use visual effects with restraint.

Respect the product's actual workflow.

And always optimize for the user's ability to accomplish their goal.
