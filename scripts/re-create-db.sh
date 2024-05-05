#!/bin/bash

# Define file paths
old_db_path="./../band_db.sqlite"
new_db_path="./../band_db_new.sqlite"
dump_file_path="./../dump.sql"
backup_dir_path="./../backup"
current_datetime=$(date +"%d.%m.%Y-%H:%M:%S")
backup_file_path="$backup_dir_path/band_db($current_datetime).sqlite"



## GENERATE

# Generate SQL script to create a database and fill it with data
sqlite3 "$old_db_path" ".dump" > "$dump_file_path"
echo "SQL script created"

# Generate new DB based on SQL script
sqlite3 "$new_db_path" ".read $dump_file_path"
echo "New DB created"



## CLEANUP

# Remove SQL script
rm "$dump_file_path"
echo "SQL script removed"

# Rename and move old DB to backup directory
mkdir -p "$backup_dir_path"  # Ensure the backup directory exists
mv "$old_db_path" "$backup_file_path"
echo "Old DB backed up to $backup_file_path"

# Rename new DB to replace old DB
mv "$new_db_path" "$old_db_path"
echo "New DB renamed to replace old DB"
