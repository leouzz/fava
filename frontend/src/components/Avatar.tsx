import { cn } from "@/lib/utils";

/* Stylised faces drawn in a 100×100 box. Original simple shapes, no assets. */
const INK = "#2b2118";
const eyes = (y = 50, dx = 13, r = 5) => (
  <>
    <circle cx={50 - dx} cy={y} r={r} fill={INK} />
    <circle cx={50 + dx} cy={y} r={r} fill={INK} />
    <circle cx={50 - dx + 1.6} cy={y - 1.8} r={r * 0.35} fill="#fff" />
    <circle cx={50 + dx + 1.6} cy={y - 1.8} r={r * 0.35} fill="#fff" />
  </>
);
const smile = (y = 66, w = 9) => (
  <path d={`M${50 - w} ${y} Q50 ${y + w * 0.9} ${50 + w} ${y}`} stroke={INK} strokeWidth="3.2" fill="none" strokeLinecap="round" />
);
const cheeks = (y = 62, dx = 22, c = "#ff8fa3") => (
  <>
    <circle cx={50 - dx} cy={y} r="5" fill={c} opacity=".55" />
    <circle cx={50 + dx} cy={y} r="5" fill={c} opacity=".55" />
  </>
);

export const FACES: Record<string, { label: string; draw: () => JSX.Element }> = {
  bear: {
    label: "Orsetto",
    draw: () => (
      <>
        <circle cx="24" cy="28" r="13" fill="#9b6a43" />
        <circle cx="76" cy="28" r="13" fill="#9b6a43" />
        <circle cx="24" cy="28" r="6" fill="#d9a77c" />
        <circle cx="76" cy="28" r="6" fill="#d9a77c" />
        <circle cx="50" cy="55" r="32" fill="#9b6a43" />
        <ellipse cx="50" cy="66" rx="15" ry="11" fill="#e8c39e" />
        <ellipse cx="50" cy="61" rx="5.5" ry="4" fill={INK} />
        {eyes(48, 13, 4.5)}
        <path d="M45 69 Q50 73 55 69" stroke={INK} strokeWidth="2.6" fill="none" strokeLinecap="round" />
      </>
    ),
  },
  cat: {
    label: "Gattino",
    draw: () => (
      <>
        <path d="M20 40 L24 12 L44 28 Z" fill="#f2a23a" />
        <path d="M80 40 L76 12 L56 28 Z" fill="#f2a23a" />
        <path d="M25 33 L27 19 L37 27 Z" fill="#ffd2a8" />
        <path d="M75 33 L73 19 L63 27 Z" fill="#ffd2a8" />
        <ellipse cx="50" cy="56" rx="33" ry="30" fill="#f2a23a" />
        <path d="M42 30 Q50 38 58 30" stroke="#d9822a" strokeWidth="4" fill="none" strokeLinecap="round" />
        {eyes(52, 13, 4.8)}
        <path d="M46 62 L54 62 L50 66 Z" fill="#e5596f" />
        <path d="M50 66 Q46 71 42 69 M50 66 Q54 71 58 69" stroke={INK} strokeWidth="2.4" fill="none" strokeLinecap="round" />
        <path d="M30 63 H14 M30 68 L16 72 M70 63 H86 M70 68 L84 72" stroke={INK} strokeWidth="1.8" strokeLinecap="round" />
      </>
    ),
  },
  bunny: {
    label: "Coniglietto",
    draw: () => (
      <>
        <ellipse cx="36" cy="22" rx="8" ry="20" fill="#f4f1ee" />
        <ellipse cx="64" cy="22" rx="8" ry="20" fill="#f4f1ee" />
        <ellipse cx="36" cy="24" rx="4" ry="14" fill="#ffb3c4" />
        <ellipse cx="64" cy="24" rx="4" ry="14" fill="#ffb3c4" />
        <circle cx="50" cy="60" r="29" fill="#f4f1ee" />
        {eyes(56, 12, 4.5)}
        {cheeks(66, 19)}
        <ellipse cx="50" cy="65" rx="4" ry="3" fill="#ff8fa3" />
        <path d="M50 68 V72 M50 72 Q46 75 44 73 M50 72 Q54 75 56 73" stroke={INK} strokeWidth="2.2" fill="none" strokeLinecap="round" />
      </>
    ),
  },
  fox: {
    label: "Volpe",
    draw: () => (
      <>
        <path d="M18 44 L22 12 L44 30 Z" fill="#ef6a2b" />
        <path d="M82 44 L78 12 L56 30 Z" fill="#ef6a2b" />
        <path d="M24 34 L26 20 L36 29 Z" fill="#3a2a22" />
        <path d="M76 34 L74 20 L64 29 Z" fill="#3a2a22" />
        <path d="M50 88 L16 50 Q18 26 50 26 Q82 26 84 50 Z" fill="#ef6a2b" />
        <path d="M50 88 L22 56 Q36 58 50 72 Q64 58 78 56 Z" fill="#fff4ea" />
        {eyes(50, 14, 4.5)}
        <circle cx="50" cy="80" r="5" fill={INK} />
      </>
    ),
  },
  panda: {
    label: "Panda",
    draw: () => (
      <>
        <circle cx="23" cy="27" r="12" fill="#222" />
        <circle cx="77" cy="27" r="12" fill="#222" />
        <circle cx="50" cy="55" r="33" fill="#fafafa" />
        <ellipse cx="36" cy="51" rx="9" ry="11" fill="#222" transform="rotate(-20 36 51)" />
        <ellipse cx="64" cy="51" rx="9" ry="11" fill="#222" transform="rotate(20 64 51)" />
        <circle cx="37" cy="50" r="3.6" fill="#fff" />
        <circle cx="63" cy="50" r="3.6" fill="#fff" />
        <ellipse cx="50" cy="65" rx="5" ry="3.6" fill="#222" />
        <path d="M45 71 Q50 75 55 71" stroke="#222" strokeWidth="2.6" fill="none" strokeLinecap="round" />
      </>
    ),
  },
  frog: {
    label: "Ranocchio",
    draw: () => (
      <>
        <circle cx="32" cy="30" r="14" fill="#5cc45a" />
        <circle cx="68" cy="30" r="14" fill="#5cc45a" />
        <ellipse cx="50" cy="60" rx="38" ry="27" fill="#5cc45a" />
        <circle cx="32" cy="29" r="9" fill="#fff" />
        <circle cx="68" cy="29" r="9" fill="#fff" />
        <circle cx="33" cy="30" r="4.6" fill={INK} />
        <circle cx="67" cy="30" r="4.6" fill={INK} />
        <path d="M28 62 Q50 82 72 62" stroke={INK} strokeWidth="3.4" fill="none" strokeLinecap="round" />
        {cheeks(64, 30, "#ff7a8a")}
      </>
    ),
  },
  owl: {
    label: "Gufetto",
    draw: () => (
      <>
        <path d="M22 30 L30 14 L40 28 M78 30 L70 14 L60 28" fill="#7b5ea7" />
        <ellipse cx="50" cy="56" rx="32" ry="34" fill="#7b5ea7" />
        <ellipse cx="50" cy="66" rx="20" ry="20" fill="#c9b6ea" />
        <circle cx="36" cy="44" r="12" fill="#fff" />
        <circle cx="64" cy="44" r="12" fill="#fff" />
        <circle cx="37" cy="45" r="6" fill={INK} />
        <circle cx="63" cy="45" r="6" fill={INK} />
        <circle cx="39" cy="43" r="2" fill="#fff" />
        <circle cx="65" cy="43" r="2" fill="#fff" />
        <path d="M45 54 L55 54 L50 63 Z" fill="#f6b23a" />
      </>
    ),
  },
  lion: {
    label: "Leoncino",
    draw: () => (
      <>
        {Array.from({ length: 12 }, (_, i) => {
          const a = (i / 12) * Math.PI * 2;
          return <circle key={i} cx={50 + Math.cos(a) * 30} cy={54 + Math.sin(a) * 30} r="13" fill="#c8641e" />;
        })}
        <circle cx="50" cy="54" r="28" fill="#f6b84a" />
        <circle cx="30" cy="34" r="6" fill="#f6b84a" />
        <circle cx="70" cy="34" r="6" fill="#f6b84a" />
        {eyes(50, 11, 4.2)}
        <path d="M45 59 L55 59 L50 64 Z" fill="#7a3d1a" />
        <path d="M50 64 Q46 69 42 67 M50 64 Q54 69 58 67" stroke={INK} strokeWidth="2.4" fill="none" strokeLinecap="round" />
      </>
    ),
  },
  chick: {
    label: "Pulcino",
    draw: () => (
      <>
        <path d="M46 18 Q50 8 54 18 Q58 10 58 20" stroke="#f5c400" strokeWidth="4" fill="none" strokeLinecap="round" />
        <circle cx="50" cy="56" r="33" fill="#ffd93b" />
        {eyes(50, 13, 4.6)}
        {cheeks(62, 22)}
        <path d="M42 60 L58 60 L50 70 Z" fill="#ff8a1f" />
      </>
    ),
  },
  girl: {
    label: "Bimba",
    draw: () => (
      <>
        <circle cx="18" cy="46" r="11" fill="#7a3b20" />
        <circle cx="82" cy="46" r="11" fill="#7a3b20" />
        <circle cx="50" cy="54" r="30" fill="#ffd2b0" />
        <path d="M20 50 Q20 20 50 20 Q80 20 80 50 Q70 34 50 34 Q34 34 20 50 Z" fill="#7a3b20" />
        <circle cx="70" cy="28" r="5" fill="#ff5c8a" />
        {eyes(56, 11, 4)}
        {cheeks(64, 18)}
        {smile(68, 7)}
      </>
    ),
  },
  boy: {
    label: "Bimbo",
    draw: () => (
      <>
        <circle cx="50" cy="56" r="30" fill="#f1c39a" />
        <path d="M20 52 Q18 22 50 22 Q82 22 80 52 Q74 38 62 36 Q66 42 60 44 Q56 36 44 38 Q30 40 20 52 Z" fill="#2f2a26" />
        <circle cx="20" cy="58" r="5" fill="#f1c39a" />
        <circle cx="80" cy="58" r="5" fill="#f1c39a" />
        {eyes(57, 11, 4)}
        {cheeks(66, 18)}
        {smile(69, 7)}
      </>
    ),
  },
  robot: {
    label: "Robot",
    draw: () => (
      <>
        <line x1="50" y1="12" x2="50" y2="24" stroke="#8a96a8" strokeWidth="4" />
        <circle cx="50" cy="11" r="5" fill="#ff5c5c" />
        <rect x="18" y="24" width="64" height="58" rx="14" fill="#c9d3e0" />
        <rect x="12" y="44" width="8" height="18" rx="3" fill="#8a96a8" />
        <rect x="80" y="44" width="8" height="18" rx="3" fill="#8a96a8" />
        <rect x="27" y="38" width="46" height="24" rx="10" fill="#2b3442" />
        <circle cx="39" cy="50" r="5.5" fill="#5ef0ff" />
        <circle cx="61" cy="50" r="5.5" fill="#5ef0ff" />
        <rect x="36" y="68" width="28" height="6" rx="3" fill="#8a96a8" />
      </>
    ),
  },
};

export const AVATAR_COLORS = [
  "#ff6b5e", "#ff9f1c", "#f7c948", "#3ec46d", "#1fb5a8",
  "#3d8bfd", "#7c5cff", "#d65db1", "#8d6e63", "#5b6475",
];

export interface ProfileLike {
  name: string;
  avatar: string;
  color: string;
}

export function Avatar({ profile, className, ring }: { profile: ProfileLike; className?: string; ring?: boolean }) {
  const [kind, value] = profile.avatar.split(":");
  const face = kind === "face" ? FACES[value] ?? FACES.bear : null;
  return (
    <span
      className={cn(
        "relative inline-flex aspect-square shrink-0 items-center justify-center overflow-hidden rounded-full",
        ring && "ring-2 ring-white ring-offset-2 ring-offset-background",
        className,
      )}
      style={{ background: `radial-gradient(circle at 35% 30%, ${profile.color}, color-mix(in srgb, ${profile.color} 70%, #000))` }}
      aria-label={profile.name}
    >
      {face ? (
        <svg viewBox="0 0 100 100" className="h-[86%] w-[86%] drop-shadow-sm">
          {face.draw()}
        </svg>
      ) : (
        <img
          src={`/api/covers/${value}.png`}
          alt=""
          className="h-[82%] w-[82%] object-contain drop-shadow-md"
          onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")}
        />
      )}
    </span>
  );
}
