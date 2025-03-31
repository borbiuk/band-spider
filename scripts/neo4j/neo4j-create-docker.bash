#!/bin/bash

# Run Neo4j in Docker
# Documentation: https://neo4j.com/docs/operations-manual/current/docker/introduction/

# Neo4j Browser port: 7474
# Bolt protocol port: 7687
# authentication credentials (admin/password): neo4j/secretgraph

docker run \
    --publish=7474:7474 \
    --publish=7687:7687 \
    --env NEO4J_AUTH=neo4j/secretgraph \
    --name bandplay-neo4j \
    neo4j:latest
