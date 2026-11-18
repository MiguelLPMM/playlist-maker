// Small inline stroke icons (no icon library).

const PATHS = {
  menu: "M4 6h16M4 12h16M4 18h16",
  chevronRight: "M9 6l6 6-6 6",
  chevronLeft: "M15 18l-6-6 6-6",
  folder: "M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.2h7.5A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z",
  folderPlus: "M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.2h7.5A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5zM12 10.5v6M9 13.5h6",
  refresh: "M20 12a8 8 0 1 1-2.34-5.66L20 8.5M20 3.5v5h-5",
  close: "M6 6l12 12M18 6L6 18",
  pencil: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
  trash: "M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13",
  download: "M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 20h14",
  upload: "M12 20V9m0 0l-4.5 4.5M12 9l4.5 4.5M5 4h14",
} as const;

export type IconName = keyof typeof PATHS;

export default function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
