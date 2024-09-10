WITH input_item_accounts AS (
    SELECT accountId FROM 'items-to-accounts'
    WHERE itemId = (SELECT id FROM items WHERE url = 'https://phonicarecords.bandcamp.com/track/energy-breakthrough-adam-pits-lightspeed-mix-2')
)
SELECT i.url, COUNT(*) as frequency
FROM 'items-to-accounts' ita
         JOIN items i ON ita.itemId = i.id
WHERE ita.accountId IN (SELECT accountId FROM input_item_accounts)
  AND i.url != 'https://phonicarecords.bandcamp.com/track/energy-breakthrough-adam-pits-lightspeed-mix-2'
GROUP BY i.id
ORDER BY frequency DESC
    LIMIT 20
