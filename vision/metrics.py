"""Reference text is used only after decoding; never passed into the model."""
import re


def words(text):
    return re.findall(r"[a-z0-9]+(?:'[a-z0-9]+)?", text.lower().replace("’", "'"))


def score(reference, hypothesis):
    a, b = words(reference), words(hypothesis)
    if not a:
        raise ValueError("Enter the words you actually mouthed before testing.")
    # Cells contain edit distance, substitutions, deletions, insertions.
    previous = [(j, 0, 0, j) for j in range(len(b) + 1)]
    for i, word in enumerate(a, 1):
        current = [(i, 0, i, 0)]
        for j, guess in enumerate(b, 1):
            if word == guess:
                current.append(previous[j - 1])
            else:
                candidates = []
                for cell, kind in [(previous[j - 1], 1), (previous[j], 2), (current[j - 1], 3)]:
                    val = list(cell)
                    val[0] += 1
                    val[kind] += 1
                    candidates.append(tuple(val))
                current.append(min(candidates))
        previous = current
    errors, substitutions, deletions, insertions = previous[-1]
    return {"reference": reference, "reference_words": len(a), "errors": errors,
            "substitutions": substitutions, "deletions": deletions, "insertions": insertions,
            "wer_percent": round(100 * errors / len(a), 1), "exact_match": a == b}


def personal_match(vector, examples):
    """Experimental nearest-example baseline. Similarity is NOT a probability."""
    import math
    def cosine(a, b):
        denominator = math.sqrt(sum(x*x for x in a) * sum(x*x for x in b))
        return sum(x*y for x, y in zip(a, b)) / denominator if denominator else 0
    grouped = {}
    for example in examples:
        label = example["label"]
        grouped.setdefault(label, []).append(cosine(vector, example["embedding"]))
    candidates = sorted([{"text": label, "similarity": round(sum(sorted(values, reverse=True)[:3]) / min(3, len(values)), 4),
                          "samples": len(values)} for label, values in grouped.items()], key=lambda x: x["similarity"], reverse=True)
    if len(candidates) < 2:
        return {"text": "", "accepted": False, "candidates": candidates, "reason": "Teach at least two different words, with three takes each."}
    first = candidates[0]
    accepted = first["samples"] >= 3 and first["similarity"] >= 0.90 and first["similarity"] - candidates[1]["similarity"] >= 0.015
    return {"text": first["text"] if accepted else "", "accepted": accepted, "candidates": candidates[:3],
            "reason": "Nearest taught word" if accepted else "Uncertain — try again. Similarity thresholds are experimental, not calibrated confidence."}
