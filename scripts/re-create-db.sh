#!/bin/bash

# Define file paths
old_db_path="./../band_db.sqlite"
new_db_path="./../band_db_new.sqlite"
reindex_script_path="./sql/reindex.sql"
dump_file_path="./../dump.sql"
backup_dir_path="./../backup"
current_datetime=$(date +"%d.%m.%Y-%H:%M:%S")
backup_file_path="$backup_dir_path/band_db($current_datetime).sqlite"

# Function to handle errors and exit script
handle_error() {
	echo "[ERROR] $1"
	exit 1
}

###########
# PREPARE #
###########
echo "[PREPARE]"

# Rebuild indexes of the database to decrease the size of backup
echo "Start indexes rebuilding..."
if sqlite3 "$old_db_path" ".read $reindex_script_path"; then
	echo "Indexes rebuild completed"
else
	handle_error "Failed to rebuild indexes"
fi

##############
# GENERATING #
##############
echo "[GENERATING]"

# Generate SQL script to create a database and fill it with data
echo "Start SQL script creating..."
if sqlite3 "$old_db_path" ".dump" >"$dump_file_path"; then
	echo "SQL script created"
else
	handle_error "Failed to create SQL script"
fi

# Generate new DB based on SQL script
echo "Start new DB creating..."
if sqlite3 "$new_db_path" ".read $dump_file_path"; then
	echo "New DB created"
else
	handle_error "Failed to create new DB"
fi

###########
# CLEANUP #
###########
echo "[CLEANUP]"

# Remove SQL script
if rm "$dump_file_path"; then
	echo "SQL script removed"
else
	handle_error "Failed to remove SQL script"
fi

# Rename and move old DB to backup directory
mkdir -p "$backup_dir_path" # Ensure the backup directory exists
if mv "$old_db_path" "$backup_file_path"; then
	echo "Old DB backed up to $backup_file_path"
else
	handle_error "Failed to back up old DB"
fi

# Rename new DB to replace old DB
if mv "$new_db_path" "$old_db_path"; then
	echo "New DB renamed to replace old DB"
else
	handle_error "Failed to rename new DB to replace old DB"
fi
