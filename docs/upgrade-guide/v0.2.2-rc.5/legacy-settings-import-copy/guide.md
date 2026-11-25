---
kind: upgrade-guide
description: "The settings.yaml import copy keeps only rejected sections and never their secret values, so a plugin API key no longer survives in settings.yaml.imported."
---

# A legacy settings copy no longer keeps plugin secrets

English | [中文](guide.zh.md)

## Change

A Host that starts with a `settings.yaml` in the harness home imports its sections into the active profile once, then renames the file. Previously the renamed `settings.yaml.imported` held the document verbatim, so every plugin API key in it stayed on disk indefinitely. Now:

- sections that imported successfully are not copied — they already live in the profile patch — so a document that imports whole leaves no `settings.yaml.imported`;
- a section the running composition rejects is kept, with every value its live Config schema marks `role('secret')` removed;
- a rejected section whose entry no longer exists, such as an uninstalled bundle, is kept as it was, because no schema then declares which of its fields is a secret; the warning names that file;
- each start also clears the secret values an existing `settings.yaml.imported` still holds from an earlier release, and rewrites the file only when it removes something.

Anyone who upgrades with that document present observes this. Rejected sections remain available for recovery; imported ones are read from the profile patch as before.

## Migration

1. To accept the new behavior, change nothing. After the first start, confirm that `<DSH_HOME>/settings.yaml` is gone and that either no `settings.yaml.imported` exists or it lists only rejected sections without their keys.
2. When the log warns that a kept section's entry no longer exists, read the file and delete it once nothing in it is needed: `rm "<DSH_HOME>/settings.yaml.imported"`. Confirm the next start logs no such warning.
3. When a search of the harness home finds a key in `settings.yaml.imported` that this release cannot attribute to an entry, delete that file with the same command; it is a recovery copy, never a settings source.
