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

