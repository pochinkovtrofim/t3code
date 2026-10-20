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
