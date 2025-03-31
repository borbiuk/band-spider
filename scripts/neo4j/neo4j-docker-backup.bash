#!/bin/bash

docker exec bandplay-neo4j neo4j-admin dump --database=neo4j --to=/backups/neo4j.dump
