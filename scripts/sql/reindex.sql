VACUUM;
REINDEX accounts;
REINDEX followers;
REINDEX items;
REINDEX 'items-to-accounts';
REINDEX 'items-to-tags';
REINDEX 'super-tags';
REINDEX tags;
REINDEX 'tags-to-super-tags';
