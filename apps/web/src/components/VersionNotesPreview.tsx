import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const tooltipOpenedEvent = 'qota:notes-tooltip-opened';

export default function VersionNotesPreview({
  text,
  label,
  icon,
  onClick,
}: {
  text: string | null | undefined;
  label: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  const tooltipId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>();
  const triggerFocused = useRef(false);
  const tooltipHovered = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, maxHeight: 320 });
  const hasText = !!text?.trim();

  function clearHideTimer() {
    if (hideTimer.current !== undefined) clearTimeout(hideTimer.current);
    hideTimer.current = undefined;
  }

  function show() {
    clearHideTimer();
    if (hasText) {
      document.dispatchEvent(new CustomEvent(tooltipOpenedEvent, { detail: tooltipId }));
      setOpen(true);
    }
  }

  function scheduleHide() {
    clearHideTimer();
    hideTimer.current = setTimeout(() => {
      if (!triggerFocused.current && !tooltipHovered.current && document.activeElement !== tooltipRef.current) {
        setOpen(false);
      }
    }, 160);
  }

  function dismiss() {
    clearHideTimer();
    tooltipHovered.current = false;
    if (document.activeElement === tooltipRef.current) triggerRef.current?.focus();
    setOpen(false);
  }

  useEffect(() => () => clearHideTimer(), []);

  useEffect(() => {
    function closeOtherTooltip(event: Event) {
      if ((event as CustomEvent<string>).detail !== tooltipId) setOpen(false);
    }
    document.addEventListener(tooltipOpenedEvent, closeOtherTooltip);
    return () => document.removeEventListener(tooltipOpenedEvent, closeOtherTooltip);
  }, [tooltipId]);

  useEffect(() => {
    if (!open) return;
    function onEscape(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape' && !document.querySelector('dialog[open], .dialog-backdrop')) dismiss();
    }
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !hasText) return;
    function placeTooltip() {
      const trigger = triggerRef.current;
      const tooltip = tooltipRef.current;
      if (!trigger || !tooltip) return;
      const anchor = trigger.getBoundingClientRect();
      const scrollBounds = trigger.closest('.version-table-scroll')?.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      if (anchor.bottom <= Math.max(0, scrollBounds?.top ?? 0)
        || anchor.top >= Math.min(viewportHeight, scrollBounds?.bottom ?? viewportHeight)
        || anchor.right <= Math.max(0, scrollBounds?.left ?? 0)
        || anchor.left >= Math.min(viewportWidth, scrollBounds?.right ?? viewportWidth)) {
        setOpen(false);
        return;
      }
      const width = tooltip.getBoundingClientRect().width;
      const below = viewportHeight - anchor.bottom - 20;
      const above = anchor.top - 20;
      const placeBelow = below >= 160 || below >= above;
      const maxHeight = Math.min(320, Math.max(80, placeBelow ? below : above), viewportHeight - 24);
      const height = Math.min(tooltip.scrollHeight + 2, maxHeight);
      const left = Math.max(12, Math.min(anchor.left, viewportWidth - width - 12));
      const top = Math.max(12, Math.min(placeBelow ? anchor.bottom + 8 : anchor.top - height - 8, viewportHeight - height - 12));
      setPosition((previous) => previous.left === left && previous.top === top && previous.maxHeight === maxHeight
        ? previous
        : { left, top, maxHeight });
    }
    placeTooltip();
    window.addEventListener('resize', placeTooltip);
    window.addEventListener('scroll', placeTooltip, true);
    return () => {
      window.removeEventListener('resize', placeTooltip);
      window.removeEventListener('scroll', placeTooltip, true);
    };
  }, [open, hasText, text]);

  function onTriggerKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      dismiss();
      return;
    }
    const tooltip = tooltipRef.current;
    if (!tooltip) return;
    const distances: Record<string, number> = {
      ArrowDown: 40,
      ArrowUp: -40,
      PageDown: tooltip.clientHeight * 0.8,
      PageUp: -tooltip.clientHeight * 0.8,
    };
    if (e.key in distances) {
      e.preventDefault();
      tooltip.scrollTop += distances[e.key]!;
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      tooltip.scrollTop = e.key === 'Home' ? 0 : tooltip.scrollHeight;
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`version-notes-preview${hasText ? '' : ' is-empty'}`}
        aria-label={label}
        aria-haspopup="dialog"
        aria-describedby={open && hasText ? tooltipId : undefined}
        onPointerEnter={(e) => { if (e.pointerType !== 'touch') show(); }}
        onPointerLeave={scheduleHide}
        onFocus={() => { triggerFocused.current = true; show(); }}
        onBlur={() => { triggerFocused.current = false; scheduleHide(); }}
        onKeyDown={onTriggerKeyDown}
        onClick={(e) => {
          e.stopPropagation();
          dismiss();
          onClick();
        }}
      >
        <span className="version-notes-content"><span className="version-notes-excerpt">{text || ''}</span></span>
        {icon}
      </button>
      {open && hasText && createPortal(
        <div
          ref={tooltipRef}
          id={tooltipId}
          role="tooltip"
          className="version-notes-tooltip"
          tabIndex={0}
          style={position}
          onPointerEnter={() => { tooltipHovered.current = true; clearHideTimer(); }}
          onPointerLeave={() => { tooltipHovered.current = false; scheduleHide(); }}
          onFocus={clearHideTimer}
          onBlur={scheduleHide}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              dismiss();
            }
          }}
        >
          {text}
        </div>,
        document.body,
      )}
    </>
  );
}
