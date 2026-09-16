# wipwho v0.1 — internal-use update

## Current behavior

This update keeps the original four commands/ideas: group dirty changes by request,
explain a changed line, split reviewable patches, and explicitly show missing traces.
The tool now calls its result **conversation-level provenance estimation**.
MEDIUM is an estimate; LOW stays unresolved. No HIGH confidence is emitted.

## What changed

- Successful tool results, exact content/local block matches, session/request order,
  and a compatible final-save interval are separate evidence. Command-time-only
  matches, hunk majority and latest-wins ties no longer establish attribution.
- Conditional, deferred, unawaited, reassigned or merely quoted exec patches are
  not interpreted as successfully executed edits. Transcript source is never eval'd.
- Forked histories and sidechains retain their own timelines and parent resume IDs.
  A short continuation such as “続けて” keeps the substantive request.
- Default/JSON output uses fixed-vocabulary summaries, validated session labels and
  relative paths. Full requests and commands are not printed or copied into subjects.
- Split uses unresolved quarantine patches, refuses inseparable replacement hunks,
  independently applies each patch in a temporary repository, and compares exact
  bytes. It does not normalize away CRLF differences or generate a commit script.
- Output must be a new directory outside the source repo. Large/binary/unsupported
  files require explicit text-only selection and appear as omissions in the plan.
- Git HEAD reads are batched. The optional content-addressed cache contains derived
  metadata/hashes only; every hit re-hashes the actual log and checks parser identity
  and cache integrity. Cache corruption falls back to parsing, without log copies.

## Validation and interpretation

The A–O fixture matrix covers both providers, both edit orders, separate and
overlapping intents, human-equivalent changes, rename/delete/new/binary/large files,
mixed EOL, subagents and resume. Additional cases cover failed/pending/conditional
calls, skew, autosave, future clocks, repeated identical bytes, cache corruption,
same-size/same-mtime log changes, unsafe paths, and independent split-byte checks.

Real-log samples were checked separately against raw tool content, the tool-result
row and the request timestamp: five content/request links matched, one sample was
ambiguous, and one had no usable agent trace. Claude→Codex editing of the same file
was observed. Reverse ordering is covered by fixtures, not claimed as a live finding.
No conversation text or code excerpt is included in the audit export.

“CORRECT” in this audit means the observed content/tool/request link agrees; it is
not an oracle for an unobserved final writer. An identical human rewrite inside a
tool's interval is fundamentally indistinguishable from the same bytes left by the
tool. That case is classified AMBIGUOUS in the audit, although the product can still
show a MEDIUM historical-content estimate. False causal attribution is not ruled out.

## Bugs found during this update

- Time-only attribution could assign unrelated autosaves or background work.
- Failed/pending or unused quoted patches could look like executed edits.
- Dominant-hunk and latest-wins attribution hid conflicts and unmatched deletions.
- Full prompts, command text and local paths leaked through output/commit scripts.
- Reconstruction validated normalized text rather than independently applied bytes.
- Small punctuation, old deletes followed by recreation, and short continuation
  messages needed distinct handling instead of new assertions about ownership.
- During the new batch-read optimization, stdin was accidentally ignored; live Git
  dogfood exposed it and the actual-HEAD regression now checks returned blob hashes.
- A Windows separator mismatch could make link checking loop at the drive root.
  The owned stuck test was interrupted, root normalization/bounds were fixed, and
  the full test suite was rerun. No unrelated process was stopped.

## Remaining scope

Internal use on this Windows environment, not a public release. The cache and
verification copies are private but unencrypted and retained. Cold scans still
parse substantial history; missing/unsupported evidence can leave many lines
unresolved. Cross-intent replacement hunks, different base hashes/offsets, and
semantic correctness of intermediate code are outside split guarantees.

With three more hours, the single next improvement would be safe incremental
log scanning, preserving invalidation safety while reducing the
cost of reading every historical byte. No publication, push, tag or release is part
of this update. See evidence/ for the final measured validation snapshot.
