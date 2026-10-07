# @fixture/alpha

## 1.0.0

### Minor Changes

- Raise the supported Node.js floor to 22.13.0 so every published package declares the same engine range and the install-time warning is identical across the whole monorepo. Consumers on older Node.js versions must upgrade before installing this release, and the migration guide lists the affected deployment targets one by one.

- Alpha-only entry: the retry middleware now reports the topic, the partition and the offset of every failed delivery in its log record, so an operator can find the exact message in the broker without correlating timestamps by hand across services and consumer groups.

### Patch Changes

- Alpha-only fix: a consumer restarted after a long downtime no longer replays messages it already acknowledged before the restart, because the committed offset is now read back from the broker before the first poll of the new session.
