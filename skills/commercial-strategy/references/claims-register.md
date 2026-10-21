# Claims register

Each entry: `claim_id` (C01, C02...), `text`, `brand_fact_id` (or null).

- A claim is any factual statement about the product, result, price, ingredient, award, safety or health.
- Supported means the fact id exists in the facts you were given and its text actually supports the wording. A fact about "no added sugar" does not support "healthy".
- Unsupported claims stay in the register with null so a reviewer can see them. They must not be used in scenes. The validator rejects scenes that reference them.
