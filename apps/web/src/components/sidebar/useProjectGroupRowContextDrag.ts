import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { PointerEvent as ReactPointerEvent } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import {
  dropThreadContext,
  endThreadContextDrag,
  moveThreadContextDrag,
} from "../chat/threadContextDrag";
import { SidebarPointerSensor } from "../Sidebar.pointer";

// fork: mirrors Sidebar.tsx SIDEBAR_DRAG_DISTANCE, contextDragThreads and
// pointerOutsideThreadList; keep in sync.
const CONTEXT_DRAG_DISTANCE = 6;
const ignore = () => {};

export function useProjectGroupRowContextDrag(input: {
  readonly threadKey: string;
  readonly title: string;
  readonly disabled: boolean;
}) {
  const onPointerDown = useStableCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!event.nativeEvent.isPrimary || event.button !== 0) return;
    // Rows span the thread list's width, so a row's edges are the list's.
    const bounds = event.currentTarget.getBoundingClientRect();
    const outsideList = (point: { x: number; y: number }) =>
      point.x < bounds.left || point.x > bounds.right;
    const draggedThreads = (): ReadonlyArray<ScopedThreadRef> => {
      const selected = useThreadSelectionStore.getState().selectedThreadKeys;
      const keys = selected.has(input.threadKey) ? [...selected] : [input.threadKey];
      return keys.flatMap((key) => {
        const ref = parseScopedThreadKey(key);
        return ref ? [ref] : [];
      });
    };
    void new SidebarPointerSensor({
      active: input.threadKey,
      event: event.nativeEvent,
      options: {
        distance: CONTEXT_DRAG_DISTANCE,
        onAttach: ignore,
        onFinish: endThreadContextDrag,
        onMove: (point) => {
          if (outsideList(point)) {
            moveThreadContextDrag(point, {
              title: input.title.trim() || "Thread",
              count: draggedThreads().length,
            });
          } else {
            endThreadContextDrag();
          }
          return true;
        },
        onDrop: (point) => {
          if (!outsideList(point)) return false;
          dropThreadContext(point, draggedThreads());
          return true;
        },
      },
      onPending: ignore,
      onStart: ignore,
      onMove: ignore,
      onEnd: ignore,
      onCancel: ignore,
      onAbort: ignore,
    });
  });
  return {
    listeners: input.disabled ? undefined : { onPointerDown },
    setNodeRef: ignore,
    transform: null,
    transition: undefined,
    isDragging: false,
  };
}
