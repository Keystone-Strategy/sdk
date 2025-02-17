import pMap from 'p-map';

import S3 from 'aws-sdk/clients/s3';

import {
  Entity,
  GraphObjectFilter,
  GraphObjectIteratee,
  Relationship,
  GraphObjectStore,
  GraphObjectIndexMetadata,
  GetIndexMetadataForGraphObjectTypeParams,
  IntegrationStep,
  insertToMongoCollection,
} from '@keystone-labs/integration-sdk-core';

import {
  iterateEntityTypeIndex,
  iterateRelationshipTypeIndex,
} from './indices';
import { InMemoryGraphObjectStore } from '../memory';
import _ from 'lodash';
import { Parser } from 'json2csv';
import { buildPropertyParameters } from './neo4jUtilities';

const s3Client = new S3({ region: 'us-east-1' });

export interface CloudServiceCSVGraphObjectStoreParams {
  integrationSteps?: IntegrationStep[];
}

interface GraphObjectIndexMetadataMap {
  /**
   * Map of _type to GraphObjectIndexMetadata
   */
  entities: Map<string, GraphObjectIndexMetadata>;
  /**
   * Map of _type to GraphObjectIndexMetadata
   */
  relationships: Map<string, GraphObjectIndexMetadata>;
}

/**
 * TODO: Write this comment to explain why the thing is the way it is
 */
function integrationStepsToGraphObjectIndexMetadataMap(
  integrationSteps: IntegrationStep[],
): Map<string, GraphObjectIndexMetadataMap> {
  const stepIdToGraphObjectIndexMetadataMap = new Map<
    string,
    GraphObjectIndexMetadataMap
  >();

  for (const step of integrationSteps) {
    const metadataMap: GraphObjectIndexMetadataMap = {
      entities: new Map(),
      relationships: new Map(),
    };

    for (const entityMetadata of step.entities) {
      if (entityMetadata.indexMetadata) {
        metadataMap.entities.set(
          entityMetadata._type,
          entityMetadata.indexMetadata,
        );
      }
    }

    for (const relationshipMetadata of step.relationships) {
      if (relationshipMetadata.indexMetadata) {
        metadataMap.relationships.set(
          relationshipMetadata._type,
          relationshipMetadata.indexMetadata,
        );
      }
    }

    stepIdToGraphObjectIndexMetadataMap.set(step.id, metadataMap);
  }

  return stepIdToGraphObjectIndexMetadataMap;
}

export class CloudServiceCSVGraphObjectStore implements GraphObjectStore {
  private readonly localGraphObjectStore = new InMemoryGraphObjectStore();
  private readonly stepIdToGraphObjectIndexMetadataMap: Map<
    string,
    GraphObjectIndexMetadataMap
  >;
  private readonly uniqueIdentifier = process.env.UUID;
  private readonly timePeriod = `${process.env.EXCHANGE_START_DATE}-${process.env.EXCHANGE_END_DATE}`;
  private readonly exchangeUserId = `${process.env.EXCHANGE_USER_ID}`;

  constructor(params?: CloudServiceCSVGraphObjectStoreParams) {
    if (params?.integrationSteps) {
      this.stepIdToGraphObjectIndexMetadataMap =
        integrationStepsToGraphObjectIndexMetadataMap(params.integrationSteps);
    }
  }

  async addEntities(stepId: string, newEntities: Entity[]) {
    await this.localGraphObjectStore.addEntities(stepId, newEntities);
  }

  async addRelationships(stepId: string, newRelationships: Relationship[]) {
    await this.localGraphObjectStore.addRelationships(stepId, newRelationships);
  }

  /**
   * The FileSystemGraphObjectStore first checks to see if the entity exists
   * in the InMemoryGraphObjectStore. If not, it then checks to see if it is
   * located on disk.
   */
  async findEntity(_key: string | undefined): Promise<Entity | undefined> {
    if (!_key) return;
    const bufferedEntity = await this.localGraphObjectStore.findEntity(_key);
    return bufferedEntity;
  }

  async iterateEntities<T extends Entity = Entity>(
    filter: GraphObjectFilter,
    iteratee: GraphObjectIteratee<T>,
  ) {
    await this.localGraphObjectStore.iterateEntities(filter, iteratee);

    await iterateEntityTypeIndex({
      type: filter._type,
      iteratee,
    });
  }

  async iterateRelationships<T extends Relationship = Relationship>(
    filter: GraphObjectFilter,
    iteratee: GraphObjectIteratee<T>,
  ) {
    await this.localGraphObjectStore.iterateRelationships(filter, iteratee);

    await iterateRelationshipTypeIndex({
      type: filter._type,
      iteratee,
    });
  }

  async flush(
    onEntitiesFlushed?: (entities: Entity[]) => Promise<void>,
    onRelationshipsFlushed?: (relationships: Relationship[]) => Promise<void>,
  ) {
    await this.flushEntitiesToDisk(onEntitiesFlushed);
    await this.flushRelationshipsToDisk(onRelationshipsFlushed);
  }

  async flushEntitiesToDisk(
    onEntitiesFlushed?: (entities: Entity[]) => Promise<void>,
  ) {
    await pMap(
      this.localGraphObjectStore.collectEntitiesByStep(),
      async ([stepId, entities]) => {
        console.log('flushEntitiesToDisk', stepId);
        const entitiesTypes = _.groupBy(entities, '_type');
        for (const eTypeKey of Object.keys(entitiesTypes)) {
          const eTypeArray = entitiesTypes[eTypeKey];

          const json2csvParser = new Parser();
          const csv = json2csvParser.parse(
            eTypeArray.map((a) => {
              return buildPropertyParameters(a);
            }),
          );

          const buf = Buffer.from(csv, 'utf8');

          const fileKey = `collect/${this.uniqueIdentifier}-${this.timePeriod}-${this.exchangeUserId}-${stepId}-ENTITY-${eTypeKey}.csv`;
          const r = await s3Client
            .putObject({
              Bucket: process.env.COLLECT_FILES_S3_BUCKET || '',
              Key: fileKey,
              Body: buf,
            })
            .promise();

          const eTag = r.ETag;
          if (!eTag) throw new Error('no etag');

          await insertToMongoCollection(
            process.env.MONGO_GRAPH_DB_NAME!,
            'sync_collected_files',
            {
              type: 'ENTITY',
              metadata: {
                entity_type: eTypeKey,
              },
              file_key: fileKey,
              e_tag: eTag,
              created_at: new Date(),
              updated_at: new Date(),
              status: 'QUEUED',
            },
          );
        }

        this.localGraphObjectStore.flushEntities(entities);
        if (onEntitiesFlushed) await onEntitiesFlushed(entities);
      },
    );
  }

  async flushRelationshipsToDisk(
    onRelationshipsFlushed?: (relationships: Relationship[]) => Promise<void>,
  ) {
    await pMap(
      this.localGraphObjectStore.collectRelationshipsByStep(),
      async ([stepId, relationships]) => {
        const relationshipTypes = _.groupBy(relationships, '_type');
        for (const rTypeKey of Object.keys(relationshipTypes)) {
          const rTypeArray = relationshipTypes[rTypeKey];

          const rFromType = _.groupBy(rTypeArray, 'fromType');
          for (const rFromTypeKey of Object.keys(rFromType)) {
            const rFromTypeArray = rFromType[rFromTypeKey];

            const rToType = _.groupBy(rFromTypeArray, 'toType');
            for (const rToTypeKey of Object.keys(rToType)) {
              const rToTypeArray = rToType[rToTypeKey];

              const json2csvParser = new Parser();
              const csv = json2csvParser.parse(
                rToTypeArray.map((a) => {
                  const sanitizedRelationship = buildPropertyParameters(a);
                  return sanitizedRelationship;
                }),
              );

              const buf = Buffer.from(csv, 'utf8');

              const fileKey = `collect/${this.uniqueIdentifier}-${this.timePeriod}-${this.exchangeUserId}-${stepId}-RELATIONSHIP-${rTypeKey}-${rFromTypeKey}-${rToTypeKey}.csv`;
              const r = await s3Client
                .putObject({
                  Bucket: process.env.COLLECT_FILES_S3_BUCKET || '',
                  Key: fileKey,
                  Body: buf,
                })
                .promise();

              const eTag = r.ETag;
              if (!eTag) throw new Error('no etag');

              await insertToMongoCollection(
                process.env.MONGO_GRAPH_DB_NAME!,
                'sync_collected_files',
                {
                  type: 'RELATIONSHIP',
                  file_key: fileKey,
                  e_tag: eTag,
                  metadata: {
                    relationship_type: rTypeKey,
                    from_entity_type: rFromTypeKey,
                    to_entity_type: rToTypeKey,
                  },
                  created_at: new Date(),
                  updated_at: new Date(),
                  status: 'QUEUED',
                },
              );
            }
          }
        }
        this.localGraphObjectStore.flushRelationships(relationships);
        if (onRelationshipsFlushed) {
          await onRelationshipsFlushed(relationships);
        }
      },
    );
  }

  getIndexMetadataForGraphObjectType({
    stepId,
    _type,
    graphObjectCollectionType,
  }: GetIndexMetadataForGraphObjectTypeParams):
    | GraphObjectIndexMetadata
    | undefined {
    if (!this.stepIdToGraphObjectIndexMetadataMap) {
      return undefined;
    }

    const map = this.stepIdToGraphObjectIndexMetadataMap.get(stepId);
    return map && map[graphObjectCollectionType].get(_type);
  }
}
