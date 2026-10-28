import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;

export function IconBook(props: P) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...props}>
      <path
        d="M6 4.5h10.5a2.5 2.5 0 0 1 2.5 2.5V20H7.5A2.5 2.5 0 0 0 5 22V7A2.5 2.5 0 0 1 7.5 4.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M6 20h13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function IconStar(props: P) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...props}>
      <path
        d="M12 3.5l2.85 5.78 6.38.93-4.62 4.5 1.09 6.36L12 18.9l-5.7 3 1.09-6.36-4.62-4.5 6.38-.93L12 3.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconList(props: P) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...props}>
      <path d="M8 7h13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M8 12h13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M8 17h13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M3.5 7h.01" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <path d="M3.5 12h.01" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <path d="M3.5 17h.01" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function IconBookmark(props: P) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...props}>
      <path
        d="M7 4.5h10v17l-5-3-5 3v-17Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconHighlight(props: P) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...props}>
      <path
        d="M8.5 14.5 18 5a2 2 0 0 1 2.8 2.8l-9.5 9.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M7 16l-2 6 6-2" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M4.5 12.5h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function IconQuote(props: P) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...props}>
      <path
        d="M7.5 16.5c-2.2 0-4-1.8-4-4 0-3.7 2.1-6.4 5.8-7.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M18.5 16.5c-2.2 0-4-1.8-4-4 0-3.7 2.1-6.4 5.8-7.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconSearch(props: P) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...props}>
      <path
        d="M10.5 18.5a8 8 0 1 1 0-16 8 8 0 0 1 0 16Z"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path d="M16.7 16.7 21 21" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function IconSettings(props: P) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...props}>
      <path
        d="M12 15.8a3.8 3.8 0 1 0 0-7.6 3.8 3.8 0 0 0 0 7.6Z"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M19.4 13.3v-2.6l-2-.7a7.7 7.7 0 0 0-.8-1.5l.9-1.9-1.9-1.9-1.9.9a7.7 7.7 0 0 0-1.5-.8l-.7-2h-2.6l-.7 2a7.7 7.7 0 0 0-1.5.8l-1.9-.9-1.9 1.9.9 1.9a7.7 7.7 0 0 0-.8 1.5l-2 .7v2.6l2 .7c.2.5.5 1 .8 1.5l-.9 1.9 1.9 1.9 1.9-.9c.5.3 1 .6 1.5.8l.7 2h2.6l.7-2c.5-.2 1-.5 1.5-.8l1.9.9 1.9-1.9-.9-1.9c.3-.5.6-1 .8-1.5l2-.7Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconMoon(props: P) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...props}>
      <path
        d="M21 14.6A8.5 8.5 0 0 1 9.4 3a7 7 0 1 0 11.6 11.6Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconChevronLeft(props: P) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...props}>
      <path d="M14.5 5.5 8 12l6.5 6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconChevronRight(props: P) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...props}>
      <path d="M9.5 5.5 16 12l-6.5 6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconHeart(props: P) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" {...props}>
      <path
        d="M12 20.2S4.2 15.6 3.1 10.6C2.4 7.4 4.6 4.8 7.4 4.8c1.9 0 3.5 1 4.6 2.7 1.1-1.7 2.7-2.7 4.6-2.7 2.8 0 5 2.6 4.3 5.8C19.8 15.6 12 20.2 12 20.2Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconPin(props: P) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" {...props}>
      <path
        d="M9 3.8h6l-.9 6.1 3.1 3.1H6.8l3.1-3.1L9 3.8Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M12 13v7.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function IconMore(props: P) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" {...props}>
      <circle cx="5" cy="12" r="1.6" fill="currentColor" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <circle cx="19" cy="12" r="1.6" fill="currentColor" />
    </svg>
  );
}

export function IconImage(props: P) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" {...props}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="9" cy="10" r="1.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4.5 17.5 10 12.5l3.5 3 3-2.5 3 3" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

export function IconRefresh(props: P) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" {...props}>
      <path
        d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path d="M19.7 3.8v3.4h-3.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconPlay(props: P) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" {...props}>
      <path d="M8 5.5v13l10-6.5Z" fill="currentColor" />
    </svg>
  );
}

export function IconPause(props: P) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" {...props}>
      <rect x="7" y="5.5" width="3.4" height="13" rx="1" fill="currentColor" />
      <rect x="13.6" y="5.5" width="3.4" height="13" rx="1" fill="currentColor" />
    </svg>
  );
}

export function IconPalette(props: P) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...props}>
      <path
        d="M12 20.5a8.5 8.5 0 1 1 8.5-8.5c0 2.2-1.8 3.5-3.8 3.5h-1.3c-1 0-1.8.8-1.8 1.8 0 .5.2.9.5 1.3.3.4.5.8.5 1.2 0 .4-.3.7-.7.7Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="10.5" r="1.2" fill="currentColor" />
      <circle cx="12" cy="7.6" r="1.2" fill="currentColor" />
      <circle cx="15.9" cy="9.9" r="1.2" fill="currentColor" />
    </svg>
  );
}

export function IconLock(props: P) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...props}>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="12" cy="15.2" r="1.4" fill="currentColor" />
    </svg>
  );
}

export function IconLockOpen(props: P) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...props}>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M15.5 10.5V8a3.5 3.5 0 0 0-6.87-.9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="12" cy="15.2" r="1.4" fill="currentColor" />
    </svg>
  );
}

export function IconFolder(props: P) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...props}>
      <path
        d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.1c.5 0 1 .2 1.4.6l1.3 1.4h7.2a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-9Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconTrash(props: P) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...props}>
      <path
        d="M4.5 6.5h15M9.5 6.5V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v1.5m-8 0 .8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M10 10.5v6M14 10.5v6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

