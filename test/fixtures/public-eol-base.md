# Offline Git fixture

`public-eol-base.bundle` contains the existing public commit
`3c1b04a4a7e89791cedaecf1f1bc8d6ecd0f897b` from
https://github.com/juliangruber/isarray (MIT; accompanying LICENSE).
It has 21 tracked files and no private AIE source or agent logs.

Tests clone this frozen bundle without network access, staging, or creating
commits. All configuration changes and edits are confined to temporary repos.
The attributes cases add an untracked `.gitattributes`; this is intentionally
included in the expected dirty set and reconstruction hashes.
