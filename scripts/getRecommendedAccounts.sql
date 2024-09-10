WITH input_account_items AS (SELECT itemId
                             FROM 'items-to-accounts'
                             WHERE accountId = (SELECT id FROM accounts WHERE url = 'https://bandcamp.com/borbiuk')),
     similar_accounts AS (SELECT ita.accountId, COUNT(*) as overlap
                          FROM 'items-to-accounts' ita
                          WHERE ita.itemId IN (SELECT itemId FROM input_account_items)
                            AND ita.accountId != (SELECT id FROM accounts WHERE url = 'https://bandcamp.com/borbiuk')
                          GROUP BY ita.accountId
                          HAVING overlap > 10
                          ORDER BY overlap DESC
                          LIMIT 100)
SELECT i.url, COUNT(*) as frequency
FROM 'items-to-accounts' ita
         JOIN items i ON ita.itemId = i.id
WHERE ita.accountId IN (SELECT accountId FROM similar_accounts)
  AND ita.itemId NOT IN (SELECT itemId FROM input_account_items)
GROUP BY i.id
ORDER BY frequency DESC
LIMIT 20
