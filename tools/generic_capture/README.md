# Generic command capture

`generic_capture` is a standard-library Python package for one-shot command
capture beneath one disposable physical root. Generic mechanics do not contain
repository, GitHub, model, gateway, or service assumptions. A caller supplies
a separate canonical environment policy.

The installed agent-kit distribution is the complete Git-tracked
`tools/generic_capture/` tree at the target policy root. It is managed as
`upstream-identical`: first install copies it, ordinary upgrade projects missing
members as `ADD`, and the upgrade attestation binds every member's source/post
bytes, mode, action, and ownership. Source publication does not authorize a
target `--apply`.

## Filesystem mode contract

The allowed root must be on a filesystem that preserves exact POSIX modes.
Capture files, the invocation marker, and verification evidence are `0444`;
the finalized capture directory is `0555`. The runner and independent verifier
require those exact values. They do not accept a filesystem-specific
equivalence and do not weaken the contract on WSL.

WSL shells may inherit `TEMP` and `TMP` pointing into `/mnt/<drive>/...` DrvFS.
Without DrvFS metadata support, `chmod 0444` can be observed as `0555`, so such
a directory is not a qualified capture root. Create a disposable root on a
POSIX-mode-capable filesystem and pass its strict physical spelling, for
example:

```sh
work_root="$(mktemp -d /tmp/generic-capture.XXXXXX)"
work_root="$(cd "$work_root" && pwd -P)"
```

The checked-in test/qualification helper probes both `0444` and `0555` before
selecting a temporary parent. It tries the physical platform default first and,
on POSIX hosts, physical `/tmp` and `/var/tmp` fallbacks. An incompatible
inherited Windows temporary directory is skipped before the public capture CLI
is invoked. This selection is fixture infrastructure only: production callers
remain responsible for the explicit allowed root in the canonical request.

## Public CLI

Invoke an extracted or checked-out package by putting its parent on
`PYTHONPATH` and disabling bytecode writes:

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/allowed/package-parent \
  python3 -m generic_capture capture \
  --allowed-root /allowed \
  --request /allowed/request.json \
  --policy /allowed/policy.json

PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/allowed/verifier-parent \
  python3 -m generic_capture verify \
  --allowed-root /allowed \
  --request /allowed/request.json \
  --policy /allowed/policy.json \
  --runner-package-root /allowed/package-parent/generic_capture \
  --output /allowed/verification.json
```

The request has exactly seven keys documented by
`schemas/request.schema.json`: schema version, invocation id, argv array,
physical cwd, complete environment map, sorted unique expected return codes,
and an absent capture root. JSON inputs use UTF-8 canonical JSON: sorted object
keys, compact separators, and exactly one terminal LF.

The runner validates everything before reserving the invocation id and capture
root. Each accepted request performs one
`subprocess.Popen(argv, shell=False, cwd=cwd, env=environment)`, directs stdout
and stderr to exclusive files, waits once, and records the direct return code.
There is no inherited environment, shell, tee, retry, or reconstructed stream.

The policy schema supports two explicit rule kinds:

- `path_under_allowed_root` for directory-valued keys such as HOME and TMPDIR;
- `exact` for opaque values such as PATH, fixed flags, and a sanitized
  GIT_SSH_COMMAND string.

The sanitized record stores sorted environment key names and the SHA-256 of
the complete canonical map. It never serializes raw environment values or the
absolute cwd/capture path.

## Package CLI

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/allowed/package-parent \
  python3 -m generic_capture package \
  --allowed-root /allowed \
  --package-root /allowed/package-parent/generic_capture \
  --archive /allowed/generic-capture.tar.gz

PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/allowed/verifier-parent \
  python3 -m generic_capture verify-package \
  --allowed-root /allowed \
  --archive /allowed/generic-capture.tar.gz \
  --extract-root /allowed/fresh-extraction
```

The builder normalizes member ordering, uid/gid, names, modes, timestamps,
gzip filename, and gzip timestamp. The verifier independently checks the exact
manifest/member set and rebuilds the archive byte-for-byte before optional
exclusive safe extraction.

## Exact local gate

The standalone owning-host gate is:

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=tools \
  python3 -m unittest discover -s tools/generic_capture/tests -t tools -v
```

It uses only checked-in shims and disposable local directories. It does not
access a repository, network, credential, model, reviewer, container, gateway,
or service. `scripts/validate.sh` runs the same command so package regressions
remain part of the source validator.
