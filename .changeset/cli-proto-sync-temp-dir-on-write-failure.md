---
"@connectum/cli": patch
---

fix: `connectum proto sync` removes its temporary directory when writing the descriptor file fails

The directory was created and the file written before the block that removes the directory, so a failed write (disk full, permissions) left `connectum-proto-sync-*` behind in the system temporary directory. The write now happens inside that block. Present in 1.2.0.
