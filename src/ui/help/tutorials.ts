/**
 * Flow-focused tutorial articles for the Tutorials panel.
 * Separate from button help tips in catalog.ts.
 */

export type TutorialId =
  | "magic-morph"
  | "magic-move"
  | "holds-and-keyframes"
  | "lock-time";

export type TutorialArticle = {
  id: TutorialId;
  title: string;
  summary: string;
  sections: TutorialSection[];
};

export type TutorialSection =
  | { type: "p"; text: string }
  | { type: "steps"; title?: string; items: string[] }
  | { type: "note"; text: string };

export const TUTORIAL_ARTICLES: readonly TutorialArticle[] = [
  {
    id: "magic-morph",
    title: "Magic Morph",
    summary: "Turn one pose into the next with a quick timing chart.",
    sections: [
      {
        type: "p",
        text: "Draw pose A, leave a few hold frames, then draw pose B later on the timeline.",
      },
      {
        type: "steps",
        title: "Try it",
        items: [
          "Put the playhead on a hold frame (after pose A, before pose B).",
          "Pick Magic Morph and draw a path with a few timing ticks across it.",
          "Hit Apply — FlipCel fills the inbetweens for you.",
        ],
      },
      {
        type: "note",
        text: "Morph needs the playhead on a hold that still has a next keyframe ahead. If nothing happens, scrub a bit earlier onto the hold.",
      },
    ],
  },
  {
    id: "magic-move",
    title: "Magic Move",
    summary: "Slide a selection along a path with your own timing.",
    sections: [
      {
        type: "p",
        text: "Lasso what you want to move, draw where it should go, and tap timing ticks on that path.",
      },
      {
        type: "steps",
        title: "Try it",
        items: [
          "Choose Magic Move and lasso the artwork.",
          "Draw a trajectory, then cross it with ticks.",
          "Apply when the popup shows up.",
        ],
      },
    ],
  },
  {
    id: "holds-and-keyframes",
    title: "Holds & keyframes",
    summary: "A keyframe is a drawing; the frames after it are a hold.",
    sections: [
      {
        type: "p",
        text: "K copies the current drawing onto a new keyframe. B makes a blank one. Frames between keyframes keep showing the last drawing — that’s a hold.",
      },
      {
        type: "p",
        text: "Magic Morph looks at the hold under the playhead and morphs toward the next keyframe. Park on the hold, not on the destination drawing.",
      },
    ],
  },
  {
    id: "lock-time",
    title: "Lock Time (LT)",
    summary: "Change fps without changing how long the shot feels.",
    sections: [
      {
        type: "p",
        text: "With LT on, bumping fps rescales your keys so the animation keeps the same wall-clock length. Off, higher fps just plays the same spacing faster.",
      },
      {
        type: "p",
        text: "Find LT next to the fps field on the Layers timeline.",
      },
    ],
  },
];

export function getTutorial(id: string | null | undefined): TutorialArticle | undefined {
  if (!id) return undefined;
  return TUTORIAL_ARTICLES.find((a) => a.id === id);
}
