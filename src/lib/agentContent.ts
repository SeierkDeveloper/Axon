// What an agent may be called and say, checked the same way wherever an agent is made: registered by hand
// (POST /api/agents) or built in Agent Studio. Moved here from the registration route so the two can never disagree.

// Terms that would impersonate the Axon platform
const IMPERSONATION_TERMS = [
  "axon", "anthropic",
];

// Basic profanity / hate speech blocklist — extend as needed
const PROFANITY_TERMS = [
  "fuck", "shit", "cunt", "nigger", "nigga", "faggot", "retard",
  "bitch", "asshole", "bastard", "whore", "slut", "cock", "dick",
  "pussy", "rape", "nazi",
];

/** An acronym in capitals (FAQ, SQL, HTTPS, PDFs, QA, 3D): a real word to readers, but it breaks the letter rules. */
const isAcronym = (w: string) => /^[A-Z0-9]{2,6}s?$/.test(w.replace(/[^A-Za-z0-9]/g, ""));

function isGibberish(str: string): boolean {
  // judged word by word, leaving out acronyms: "FAQ Builder" is a name, "xkqzv bcdfg" is not
  const words = str.split(/\s+/).filter((w) => w && !isAcronym(w));
  const letters = words.join("").toLowerCase().replace(/[^a-z]/g, "");
  if (letters.length === 0) return false;
  const vowels = (letters.match(/[aeiou]/g) ?? []).length;
  // Must have at least 1 vowel and 15% vowel ratio
  if (vowels === 0) return true;
  if (vowels / letters.length < 0.15) return true;
  for (const word of words.map((w) => w.toLowerCase().replace(/[^a-z]/g, ""))) {
    // No run of more than 4 consecutive consonants, treating y as a vowel (crypto, myth, gym)
    if (/[^aeiouy]{5,}/.test(word)) return true;
    // q must be followed by u in real words
    if (/q[^u]/.test(word) || word.endsWith("q")) return true;
    // Unusual consonant pairs that don't appear in real words
    if (/wq|qw|xq|bv|vb|jq|qj|zx|xz/.test(word)) return true;
  }
  return false;
}

export function validateAgentContent(name: string, agentId: string, capabilities: string[]): string | null {
  const haystack = [name, agentId, ...capabilities].join(" ").toLowerCase().replace(/[^a-z0-9 ]/g, " ");

  for (const term of PROFANITY_TERMS) {
    if (haystack.split(/\s+/).includes(term)) {
      return "Agent name or capabilities contain inappropriate language.";
    }
  }

  const nameLower = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const idLower = agentId.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const term of IMPERSONATION_TERMS) {
    const t = term.replace(/[^a-z0-9]/g, "");
    if (nameLower.includes(t) || idLower.includes(t)) {
      return `Agent name or ID must not impersonate '${term}' or other platforms.`;
    }
  }

  if (isGibberish(name)) {
    return "Agent name appears to be gibberish. Use a descriptive name like 'Legal Document Reviewer' or 'My Research Bot'.";
  }

  return null;
}

/**
 * The longer texts Studio writes or a creator edits: the description and the instructions. The same language check as
 * a name, and nothing that claims to be Axon itself speaking. Length is checked by the caller against studioPolicy.LIMITS.
 */
export function validateAgentText(text: string): string | null {
  const words = text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/);
  for (const term of PROFANITY_TERMS) if (words.includes(term)) return "The text contains inappropriate language.";
  if (/\b(i am|i'm|this is|official)\s+(the\s+)?(axon|anthropic)\b/i.test(text)) return "An agent must not present itself as Axon or Anthropic.";
  return null;
}
