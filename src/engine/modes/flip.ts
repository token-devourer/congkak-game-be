import { randomBytes } from "node:crypto";
import type { Card, CardValue, Color, FlipSide, GameMode, OpponentCardFace, TurnContext, VisibleCardFace } from "@congcard/shared";
import { DARK_COLORS, LIGHT_COLORS } from "@congcard/shared";
import { shuffleCards } from "./standard.js";

interface FlipFace {
  color: Color | null;
  value: CardValue;
}

export interface FlipCardInternal extends Card {
  flipFaces?: Record<FlipSide, FlipFace>;
  trackingId?: string;
}

const DARK_FOR_LIGHT: Record<(typeof LIGHT_COLORS)[number], (typeof DARK_COLORS)[number]> = {
  red: "orange",
  yellow: "cyan",
  green: "purple",
  blue: "pink"
};

function opaqueId(prefix: string): string {
  return `${prefix}-${randomBytes(12).toString("base64url")}`;
}

function pairedCard(deckIndex: number, light: FlipFace, dark: FlipFace): FlipCardInternal {
  return {
    id: opaqueId("flip"),
    trackingId: opaqueId("back"),
    deckIndex,
    color: light.color,
    value: light.value,
    side: "light",
    flipFaces: { light, dark }
  };
}

export function buildFlipDeckBox(deckIndex: number): Card[] {
  const cards: FlipCardInternal[] = [];

  for (const lightColor of LIGHT_COLORS) {
    const darkColor = DARK_FOR_LIGHT[lightColor];
    cards.push(pairedCard(deckIndex, { color: lightColor, value: 0 }, { color: darkColor, value: 0 }));
    for (let value = 1; value <= 9; value += 1) {
      for (let copy = 0; copy < 2; copy += 1) {
        cards.push(
          pairedCard(
            deckIndex,
            { color: lightColor, value: value as CardValue },
            { color: darkColor, value: value as CardValue }
          )
        );
      }
    }

    const pairs: Array<[CardValue, CardValue]> = [
      ["skip", "skip"],
      ["reverse", "reverse"],
      ["draw2", "draw5"],
      ["flip", "flip"]
    ];
    for (const [lightValue, darkValue] of pairs) {
      for (let copy = 0; copy < 2; copy += 1) {
        cards.push(
          pairedCard(
            deckIndex,
            { color: lightColor, value: lightValue },
            { color: darkColor, value: darkValue }
          )
        );
      }
    }
  }

  for (let copy = 0; copy < 4; copy += 1) {
    cards.push(pairedCard(deckIndex, { color: null, value: "wild" }, { color: null, value: "wild" }));
    cards.push(pairedCard(deckIndex, { color: null, value: "wild3" }, { color: null, value: "wildColor" }));
  }

  return cards;
}

export function applyFlipSide(card: Card, side: FlipSide): void {
  const faces = (card as FlipCardInternal).flipFaces;
  if (!faces) return;
  card.color = faces[side].color;
  card.value = faces[side].value;
  card.side = side;
}

export function publicCard(card: Card): Card {
  return { id: card.id, color: card.color, value: card.value, deckIndex: card.deckIndex, ...(card.side ? { side: card.side } : {}) };
}

export function visibleCardFace(card: Card): VisibleCardFace {
  return { color: card.color, value: card.value, ...(card.side ? { side: card.side } : {}) };
}

export function oppositeCardFace(card: Card, activeSide: FlipSide): OpponentCardFace | undefined {
  const internal = card as FlipCardInternal;
  const face = internal.flipFaces?.[activeSide === "light" ? "dark" : "light"];
  if (!face || !internal.trackingId) return undefined;
  return {
    trackingId: internal.trackingId,
    color: face.color,
    value: face.value,
    side: activeSide === "light" ? "dark" : "light"
  };
}

export function flipColors(side: FlipSide): readonly Color[] {
  return side === "dark" ? DARK_COLORS : LIGHT_COLORS;
}

function isPlayable(card: Card, ctx: TurnContext): boolean {
  return card.color === null || card.color === ctx.activeColor || card.value === ctx.discardTop.value;
}

export const flipMode: GameMode = {
  id: "flip",
  initialHandSize: 7,
  buildDeck(_playerCount, deckBoxes) {
    const cards: Card[] = [];
    for (let deckIndex = 0; deckIndex < (deckBoxes ?? 1); deckIndex += 1) {
      cards.push(...buildFlipDeckBox(deckIndex));
    }
    return shuffleCards(cards);
  },
  isPlayable,
  scoreHand(hand) {
    return hand.reduce((score, card) => {
      if (typeof card.value === "number") return score + card.value;
      if (["wild", "wild3", "wildColor"].includes(String(card.value))) return score + 50;
      return score + 20;
    }, 0);
  },
  allowedOutOfTurnActions() {
    return ["catchOne", "challenge"];
  }
};
