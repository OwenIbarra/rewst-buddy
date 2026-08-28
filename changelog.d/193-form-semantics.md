---
category: Added
pr: 193
---

- **Forms are checked, not just saved.** Typed field definitions compile into Rewst's field JSON, `buddy_validate_form` reports what is wrong before writing, and every form write is read back and compared.
