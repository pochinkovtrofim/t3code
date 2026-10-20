import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  ProjectChangelogCursor,
  ProjectChangelogEntry,
  ProjectChangelogPage,
  ProjectId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ExternalLinkIcon, ScrollTextIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useClientSettings } from "../../hooks/useSettings";
import { useServerConfigs, useThreadShell } from "../../state/entities";
import { projectChangelogEnvironment } from "../../state/projectChangelog";
import { useEnvironmentQuery } from "../../state/query";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import {
  describeChangelogEntry,
  describeChangelogPage,
  type ChangelogClock,
  type ChangelogNotice,
  type ChangelogStatusLine,
} from "./projectChangelogPanel.logic";

type EntryContext = Pick<ProjectChangelogPage, "production" | "repository">;

export function ProjectChangelogPanel({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const thread = useThreadShell(threadRef);
  const config = useServerConfigs().get(threadRef.environmentId);
  if (thread === null || config === undefined) return null;
  if (config.environment.capabilities.projectChangelog !== true) {
    return (
      <ChangelogEmpty
        notice={{
          title: "Changelog unavailable",
          description: "Update this environment's T3 Code server to see the project changelog.",
        }}
      />
    );
  }
  return (
    <ProjectChangelog
      key={`${threadRef.environmentId}:${thread.projectId}`}
      environmentId={threadRef.environmentId}
      projectId={thread.projectId}
    />
  );
}

function useChangelogClock(): ChangelogClock {
  const nowMinute = useNowMinute();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  return { nowMs: Date.parse(`${nowMinute}:00.000Z`), timestampFormat };
}

function ProjectChangelog(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const head = useEnvironmentQuery(
    projectChangelogEnvironment.head({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }),
  );
  const clock = useChangelogClock();
  const [olderPages, setOlderPages] = useState(0);
  const page = head.data;
  if (page === null) {
    return head.error === null ? (
      <p className="p-3 text-xs text-muted-foreground">Loading the changelog…</p>
    ) : (
      <ChangelogEmpty notice={{ title: "Could not load the changelog", description: head.error }} />
    );
  }
  const view = describeChangelogPage(page, clock);
  const context: EntryContext = { production: page.production, repository: page.repository };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-border/60 px-3 py-2.5 text-xs">
        {page.repository ? (
          <InlineButton
            tone="muted"
            className="self-start"
            render={<a href={page.repository.url} target="_blank" rel="noopener noreferrer" />}
          >
            {page.repository.displayName}
            <ExternalLinkIcon aria-hidden className="size-3" />
          </InlineButton>
        ) : null}
        {view.production ? (
          <StatusLine line={view.production}>
            {view.production.url ? (
              <>
                {" "}
                <InlineButton
                  tone="muted"
                  render={
                    <a href={view.production.url} target="_blank" rel="noopener noreferrer" />
                  }
                >
                  View on GitHub
                </InlineButton>
              </>
            ) : null}
          </StatusLine>
        ) : null}
        {view.sync ? <StatusLine line={view.sync} /> : null}
        {head.error === null ? null : (
          <StatusLine
            line={{ tone: "warning", text: `Could not refresh the changelog: ${head.error}` }}
          />
        )}
      </div>
      {view.empty ? (
        <ChangelogEmpty notice={view.empty} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ChangelogEntries
            entries={page.entries}
            context={context}
            environmentId={props.environmentId}
          />
          <OlderEntries
            environmentId={props.environmentId}
            projectId={props.projectId}
            cursor={page.nextCursor}
            remaining={olderPages}
            context={context}
            onShowOlder={() => setOlderPages((count) => count + 1)}
          />
        </div>
      )}
    </div>
  );
}

function OlderEntries(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly cursor: ProjectChangelogCursor | null;
  readonly remaining: number;
  readonly context: EntryContext;
  readonly onShowOlder: () => void;
}) {
  if (props.cursor === null) return null;
  if (props.remaining === 0) {
    return (
      <div className="flex justify-center p-2">
        <Button size="sm" variant="ghost" onClick={props.onShowOlder}>
          Show older
        </Button>
      </div>
    );
  }
  return <OlderPage {...props} cursor={props.cursor} />;
}

function OlderPage(
  props: Parameters<typeof OlderEntries>[0] & { readonly cursor: ProjectChangelogCursor },
) {
  const older = useEnvironmentQuery(
    projectChangelogEnvironment.page({
      environmentId: props.environmentId,
      input: { projectId: props.projectId, cursor: props.cursor },
    }),
  );
  if (older.data === null) {
    return older.error === null ? (
      <p className="p-3 text-center text-xs text-muted-foreground">Loading older entries…</p>
    ) : (
      <div className="flex flex-col items-center gap-2 p-3 text-xs text-muted-foreground">
        <p>Could not load older entries: {older.error}</p>
        <Button size="sm" variant="outline" onClick={older.refresh}>
          Retry
        </Button>
      </div>
    );
  }
  return (
    <>
      <ChangelogEntries
        entries={older.data.entries}
        context={props.context}
        environmentId={props.environmentId}
      />
      <OlderEntries {...props} cursor={older.data.nextCursor} remaining={props.remaining - 1} />
    </>
  );
}

function ChangelogEntries(props: {
  readonly entries: ReadonlyArray<ProjectChangelogEntry>;
  readonly context: EntryContext;
  readonly environmentId: EnvironmentId;
}) {
  return (
    <ul>
      {props.entries.map((entry) => {
        const view = describeChangelogEntry(entry, props.context);
        return (
          <li
            key={entry.id}
            className="flex flex-col gap-1 border-b border-border/60 px-3 py-2.5 text-xs"
          >
            <p className="text-sm font-medium text-foreground">{view.title}</p>
            {view.summary ? <p className="text-muted-foreground">{view.summary}</p> : null}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
              <Badge size="sm" variant={view.badge.variant}>
                {view.badge.label}
              </Badge>
              <InlineButton
                tone="muted"
                render={<a href={view.source.url} target="_blank" rel="noopener noreferrer" />}
              >
                {view.source.label}
              </InlineButton>
              {view.threads.map((thread) => (
                <InlineButton
                  key={thread.threadId}
                  tone="muted"
                  className="min-w-0 max-w-full truncate"
                  render={
                    <Link
                      to="/$environmentId/$threadId"
                      params={buildThreadRouteParams(
                        scopeThreadRef(props.environmentId, thread.threadId),
                      )}
                    />
                  }
                >
                  {thread.title}
                </InlineButton>
              ))}
              {view.hint ? <span className="italic">{view.hint}</span> : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function StatusLine(props: { readonly line: ChangelogStatusLine; readonly children?: ReactNode }) {
  return (
    <p
      className={
        props.line.tone === "warning" ? "text-warning-foreground" : "text-muted-foreground"
      }
    >
      {props.line.text}
      {props.children}
    </p>
  );
}

function ChangelogEmpty({ notice }: { readonly notice: ChangelogNotice }) {
  return (
    <Empty size="compact">
      <EmptyMedia variant="icon">
        <ScrollTextIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{notice.title}</EmptyTitle>
        <EmptyDescription>{notice.description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
