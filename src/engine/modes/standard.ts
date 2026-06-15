import { randomInt } from "node:crypto";
import type { Card, CardValue, Color, GameMode, TurnContext } from "@congcard/shared";
import { COLORS } from "@congcard/shared";

function numberCards(color: Color, deckIndex: number): Card[] {
  const cards: Card[] = [{ id: `${deckIndex}-${color}-0-0`, color, value: 0, deckIndex }];

  for (let value = 1; value <= 9; value += 1) {
    cards.push({ id: `${deckIndex}-${color}-${value}-0`, color, value: value as CardValue, deckIndex });
    cards.push({ id: `${deckIndex}-${color}-${value}-1`, color, value: value as CardValue, deckIndex });
  }

  return cards;
}

function actionCards(color: Color, deckIndex: number): Card[] {
  return ["skip", "reverse", "draw2"].flatMap((value) => [
    { id: `${deckIndex}-${color}-${value}-0`, color, value: value as CardValue, deckIndex },
    { id: `${deckIndex}-${color}-${value}-1`, color, value: value as CardValue, deckIndex }
  ]);
}

function wildCards(deckIndex: number): Card[] {
  return ["wild", "wild4"].flatMap((value) =>
    [0, 1, 2, 3].map((copy) => ({
      id: `${deckIndex}-wild-${value}-${copy}`,
      color: null,
      value: value as CardValue,
      deckIndex
    }))
  );
}

export function shuffleCards<T>(items: T[]): T[] {
  const copy = [...items];

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    const current = copy[index]!;
    copy[index] = copy[swapIndex]!;
    copy[swapIndex] = current;
  }

  return copy;
}

export function buildSingleDeck(deckIndex: number): Card[] {
  const cards: Card[] = [];

  for (const color of COLORS) {
    cards.push(...numberCards(color, deckIndex));
    cards.push(...actionCards(color, deckIndex));
  }

  cards.push(...wildCards(deckIndex));
  return cards;
}

export const standardMode: GameMode = {
  id: "standard",
  initialHandSize: 7,
  buildDeck(_playerCount, deckBoxes) {
    const deckCount = deckBoxes ?? 1;
    const decks: Card[] = [];

    for (let deckIndex = 0; deckIndex < deckCount; deckIndex += 1) {
      decks.push(...buildSingleDeck(deckIndex));
    }

    return shuffleCards(decks);
  },
  isPlayable(card: Card, ctx: TurnContext) {
    if (card.color === null) {
      return true;
    }

    return card.color === ctx.activeColor || card.value === ctx.discardTop.value;
  },
  scoreHand(hand) {
    return hand.reduce((score, card) => {
      if (typeof card.value === "number") {
        return score + card.value;
      }

      if (card.value === "wild" || card.value === "wild4") {
        return score + 50;
      }

      return score + 20;
    }, 0);
  },
  allowedOutOfTurnActions() {
    return ["catchOne", "challenge"];
  }
};
