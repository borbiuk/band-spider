
-- replace 4804679 to your item ID
SELECT i.url, COUNT(ia2.itemId) AS group_size
FROM 'items-to-accounts' AS ia
         JOIN 'items-to-accounts' AS ia2 ON ia.accountId = ia2.accountId
         JOIN items AS i ON i.id = ia2.itemId
WHERE ia.itemId = 4804679 -- Replace with your specific item ID
  AND ia2.itemId != 4804679 -- Exclude the specific item itself
GROUP BY i.url
ORDER BY group_size DESC
LIMIT 10;
