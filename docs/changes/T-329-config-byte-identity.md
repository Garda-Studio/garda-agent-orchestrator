# Preserve unchanged configuration bytes during updates

An ordinary update reformatted existing managed JSON even when the defaults
merge changed none of its values. For example, it removed the final newline
written by agent initialization from `paths.json`. The active task profile binds
the configuration's exact bytes, so this cosmetic change correctly blocked
continued validation as configuration drift.

The configuration materializer now preserves the original file whenever its
merged values are unchanged, using the same rule already applied to workflow
configuration. Actual default additions still materialize, explicit project
values remain authoritative, and `garda.config.json` keeps its existing
canonical replacement policy. File containment and profile guards are retained.

The regression covers all four checked profile inputs in compact, LF and CRLF
forms, repeated updates, missing defaults, a new installation, canonical
replacement, dry runs and malformed existing JSON. The original failure was
also reproduced through an actual older-runtime install and ordinary update;
its task continuation remains subject to T-329's separate native acceptance.

Two existing fresh-init assertions also follow the already accepted discovery
guidance: the plural candidate section and explicit unverified coverage for an
unknown stack. They retain the checks that compile and suite commands remain
unconfigured until ordinary agent setup.
