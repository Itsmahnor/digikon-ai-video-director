# Revise mode

Input: a list of revision tickets, each with finding_id, scene_ids, owner_skill, instruction and attempt number.

1. Group tickets by scene. Touch only the scenes named. Leave every other scene byte-for-byte unchanged.
2. Apply the owner skill's rules to the named scenes only.
3. Re-check recipe limits (duration range, max uses per film) across the whole plan, because a change can break a limit elsewhere.
4. After two attempts on the same finding, stop and return an escalation instead of a third plan.

Output: the changed scenes and edit uses only, plus a one-line reason per change.
