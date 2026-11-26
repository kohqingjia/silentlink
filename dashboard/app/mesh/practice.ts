// Everyday prompts for collecting labelled examples, not a phonetic coverage test.
export const practiceGroups = [
  {
    title: "Start here",
    sentences: [
      "Please bring me a glass of water",
      "Thank you for helping me today",
      "Can we meet tomorrow morning",
      "I would like a cup of tea",
      "Please turn on the lights",
      "I need a little more time",
    ],
  },
  {
    title: "Everyday requests",
    sentences: [
      "Could you open the window please",
      "Please close the door behind you",
      "I am ready to order my food",
      "Can you pass me the blue pen",
      "I would like to go home now",
      "Please put the book on the table",
    ],
  },
  {
    title: "Making plans",
    sentences: [
      "Let us take a walk after lunch",
      "I will be there in five minutes",
      "We can talk about it later",
      "Please call me when you arrive",
      "I have an appointment this afternoon",
      "Would you like to join us tonight",
    ],
  },
  {
    title: "Questions and replies",
    sentences: [
      "Where did you leave my phone",
      "How much does this one cost",
      "Could you say that again please",
      "Yes that sounds good to me",
      "I do not understand the question",
      "What would you like for dinner",
    ],
  },
  {
    title: "Help and comfort",
    sentences: [
      "Could you help me with this",
      "I need to take a short break",
      "Please wait here for a moment",
      "I am feeling much better today",
      "The room is a little too warm",
      "Please move a little closer to me",
    ],
  },
];

export const prompts = practiceGroups.flatMap((group) => group.sentences);
export const takesPerSentence = 3;

// Match the API's label normalization so capital letters/punctuation do not
// hide already-saved takes or restart a completed sentence.
export function sentenceKey(text: string) {
  return (
    text
      .toLowerCase()
      .replaceAll("’", "'")
      .match(/[a-z0-9]+(?:'[a-z0-9]+)?/g) || []
  ).join(" ");
}

export function countExamples(examples: { label: string }[]) {
  return examples.reduce<Record<string, number>>((counts, example) => {
    const key = sentenceKey(example.label);
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

export function nextSentence(label: string, counts: Record<string, number>) {
  const current = prompts.findIndex(
    (text) => sentenceKey(text) === sentenceKey(label),
  );
  const following = [
    ...prompts.slice(current + 1),
    ...prompts.slice(0, current + 1),
  ];
  return (
    following.find(
      (text) => (counts[sentenceKey(text)] || 0) < takesPerSentence,
    ) || following[0]
  );
}
