# Project threads

A project thread is one long-running manager chat for a project. You tell it what you
want done, and it launches ordinary threads to do the work, follows up on them, and
reports where each one stands. It does not edit code or run commands that change
anything itself. Every change happens in a thread it launches, so each one keeps its own
history, diff, and worktree.

Each project has at most one project thread. It can steer any thread in its project,
including threads you started yourself.

## Open a project thread

On web and desktop, open a project's project thread from any of these:

- The project's header in the sidebar; see
  [Group threads by project](./thread-sidebar.md#group-threads-by-project).
- The project list on the new-thread screen. Sending from the composer there still
  starts an ordinary thread.
- **Open project thread...** in the command palette.

If the project has no project thread yet, opening it creates one. A connection that
cannot change threads can open an existing project thread but cannot create one.

## Settings

Open **Settings → General → Project threads**. To change these for one project, pick
the project in the "Applying settings for …" sentence at the top of the page; see
[Settings and project overrides](./project-settings.md).

- **Project threads** turns the feature on or off. When it is off, an existing
  project thread behaves like any other thread.
- **Project thread instructions** is the prompt a project thread follows on every turn.
  Edit it to change how it plans, briefs, and reports. The reset button beside the title
  restores the built-in prompt, or the environment's prompt when a project is picked.

Codex and Claude run project-thread turns read-only, so the project thread cannot
change files even if a request asks it to. Other providers follow the instructions only
as guidance.

Both settings need an environment running a T3 Code version with project threads.
When a selected environment is older, the controls stay locked until you update it.

## Changelog

The project thread's **Changelog** tab lists what landed on the project's GitHub default
branch, newest first, in plain language. Open it from the changelog button next to the
project thread's title, or with **Show project changelog** in the command palette. Each
entry links to its pull request or commit on GitHub and to the T3 Code thread that did the
work when T3 Code knows it, and says whether it is in production yet.

Production is detected automatically. T3 Code uses the repository's production deployment
first, then its latest release or tag. A repository with none of these counts everything
merged to the default branch as in production. The line above the entries says which one
was used.

- Only projects that have a project thread are kept up to date.
- The changelog reads GitHub with the same sign-in T3 Code already uses for pull requests;
  see [Connect an account](./source-control.md#github).
- Entries are written by the environment's text generation model. Until an entry is
  summarized it shows the pull request title or commit subject.
