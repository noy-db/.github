---
'@noy-db/only': patch
'@noy-db/deleted-yesterday': minor
---

One live row and one dead one: the shape that took core's @dev rail down for
three snapshot runs. `changeset version` refuses the WHOLE run on the dead row,
so the live bump does not ship either.
