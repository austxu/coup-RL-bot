import type { IconName } from '../game/labels';

// 24px stroke icons, drawn for this project.
const PATHS: Record<IconName, string> = {
  income: 'M12 4v16M5 12h14',
  aid: 'M8.5 9.5a3.5 3.5 0 1 0 0-.01M15.5 14.5a3.5 3.5 0 1 0 0-.01M11 12.5l2 0',
  coup: 'M12 3v4M12 17v4M3 12h4M17 12h4M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 1 0 0-7',
  tax: 'M4 18h16M5 16l-1.5-9 5 4L12 5l3.5 6 5-4L19 16z',
  assassinate: 'M5 19l4-4M8 13l3 3M10.5 13.5L19 5l.5-1-1 .5-8.5 8.5',
  steal: 'M12 3v11M8.5 6.5h7M6 12a6 6 0 0 0 12 0M6 12l-2 1.5M18 12l2 1.5',
  exchange: 'M5 8h12l-3-3M19 16H7l3 3',
  challenge: 'M13 3L5 13.5h6L10 21l8-10.5h-6z',
  block: 'M12 3l7 3v5.5c0 4.5-3 7.6-7 9.5-4-1.9-7-5-7-9.5V6z',
  lose: 'M7 3.5h10a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5zM9.5 9.5l5 5M14.5 9.5l-5 5',
  trophy: 'M8 4h8v5a4 4 0 0 1-8 0zM8 6H5a2.5 2.5 0 0 0 3 4M16 6h3a2.5 2.5 0 0 1-3 4M12 13v4M9 20h6',
  turn: 'M12 6a6 6 0 1 1-6 6M6 6v4h4',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5',
  eyeOff: 'M3 3l18 18M10.6 6.1A9.6 9.6 0 0 1 12 6c6 0 9.5 6 9.5 6a16 16 0 0 1-3 3.6M6.4 7.6A16 16 0 0 0 2.5 12S6 18 12 18a9 9 0 0 0 4-.9M10 10.2a2.5 2.5 0 0 0 3.6 3.5',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  x: 'M6 6l12 12M18 6L6 18',
  deal: 'M8 5h9a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM4 8v10',
  spark: 'M12 3v5M12 16v5M3 12h5M16 12h5M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18',
  arrowLeft: 'M19 12H5M11 6l-6 6 6 6',
  arrowRight: 'M5 12h14M13 6l6 6-6 6',
  play: 'M8 5.5v13l10.5-6.5z',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 16.8v.2',
  replay: 'M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4M10.5 9.5v5l4-2.5z',
  coin: 'M12 4a8 8 0 1 0 0 16 8 8 0 1 0 0-16M12 8v8M9.5 10h3.5a1.5 1.5 0 0 1 0 3h-2a1.5 1.5 0 0 0 0 3H14',
  cpu: 'M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
};

export function Icon({ name, size = 16, class: cls = '' }: { name: IconName; size?: number; class?: string }) {
  return (
    <svg
      class={`icon ${cls}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
