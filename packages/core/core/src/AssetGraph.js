// @flow

import Graph from './Graph';
import type {
  Asset,
  Bundle,
  CacheEntry,
  Dependency as IDependency,
  File,
  FilePath,
  GraphTraversalCallback,
  Node,
  NodeId,
  Target,
  TransformerRequest
} from '@parcel/types';
import {md5FromString} from '@parcel/utils/src/md5';
import Dependency from './Dependency';

export const nodeFromRootDir = (rootDir: string) => ({
  id: rootDir,
  type: 'root',
  value: rootDir
});

export const nodeFromDep = (dep: IDependency) => ({
  id: dep.id,
  type: 'dependency',
  value: dep
});

export const nodeFromFile = (file: File) => ({
  id: file.filePath,
  type: 'file',
  value: file
});

export const nodeFromTransformerRequest = (req: TransformerRequest) => ({
  id: md5FromString(`${req.filePath}:${JSON.stringify(req.env)}`),
  type: 'transformer_request',
  value: req
});

export const nodeFromAsset = (asset: Asset) => ({
  id: asset.id,
  type: 'asset',
  value: asset
});

const getFileNodesFromGraph = (graph: Graph<Node>): Array<Node> => {
  return Array.from(graph.nodes.values()).filter(
    (node: any) => node.type === 'file'
  );
};

const getFilesFromGraph = (graph: Graph<Node>): Array<File> => {
  return getFileNodesFromGraph(graph).map(node => node.value);
};

const getDepNodesFromGraph = (graph: Graph<Node>): Array<Node> => {
  return Array.from(graph.nodes.values()).filter(
    (node: any) => node.type === 'dependency'
  );
};

type DepUpdates = {|
  newRequest?: TransformerRequest,
  prunedFiles: Array<File>
|};

type FileUpdates = {|
  newDeps: Array<Dependency>,
  addedFiles: Array<File>,
  removedFiles: Array<File>
|};

type AssetGraphOpts = {|
  entries?: Array<string>,
  targets?: Array<Target>,
  transformerRequest?: TransformerRequest,
  rootDir: string
|};

/**
 * AssetGraph is a Graph with some extra rules.
 *  * Nodes can only have one of the following types "root", "dependency", "file", "asset"
 *  * There is one root node that represents the root directory
 *  * The root note has edges to dependency nodes for each entry file
 *  * A dependency node should have an edge to exactly one file node
 *  * A file node can have one to many edges to asset nodes which can have zero to many edges dependency nodes
 */
export default class AssetGraph extends Graph<Node> {
  incompleteNodes: Map<NodeId, Node> = new Map();
  invalidNodes: Map<NodeId, Node> = new Map();

  initializeGraph({
    entries,
    targets,
    transformerRequest,
    rootDir
  }: AssetGraphOpts) {
    let rootNode = nodeFromRootDir(rootDir);
    this.setRootNode(rootNode);

    let nodes = [];
    if (entries) {
      if (!targets) {
        throw new Error('Targets are required when entries are specified');
      }

      for (let entry of entries) {
        for (let target of targets) {
          let node = nodeFromDep(
            new Dependency({
              moduleSpecifier: entry,
              target: target,
              env: target.env,
              isEntry: true
            })
          );

          nodes.push(node);
        }
      }
    } else if (transformerRequest) {
      let node = nodeFromTransformerRequest(transformerRequest);
      nodes.push(node);
    }

    this.replaceNodesConnectedTo(rootNode, nodes);
    for (let depNode of nodes) {
      this.incompleteNodes.set(depNode.id, depNode);
    }
  }

  removeNode(node: Node): this {
    this.incompleteNodes.delete(node.id);
    return super.removeNode(node);
  }

  /**
   * Marks a dependency as resolved, and connects it to a transformer
   * request node for the file it was resolved to.
   */
  resolveDependency(dep: IDependency, req: TransformerRequest): DepUpdates {
    let newRequest;

    let depNode = nodeFromDep(dep);
    this.incompleteNodes.delete(depNode.id);
    this.invalidNodes.delete(depNode.id);

    let requestNode = nodeFromTransformerRequest(req);
    let {added, removed} = this.replaceNodesConnectedTo(depNode, [requestNode]);

    if (added.nodes.size) {
      newRequest = req;
      this.incompleteNodes.set(requestNode.id, requestNode);
    }

    let prunedFiles = getFilesFromGraph(removed);
    return {newRequest, prunedFiles};
  }

  /**
   * Marks a transformer request as resolved, and connects it to asset and file
   * nodes for the generated assets and connected files.
   */
  resolveTransformerRequest(
    req: TransformerRequest,
    cacheEntry: CacheEntry
  ): FileUpdates {
    let newDepNodes: Array<Node> = [];

    let requestNode = nodeFromTransformerRequest(req);
    this.incompleteNodes.delete(requestNode.id);
    this.invalidNodes.delete(requestNode.id);

    // Get connected files from each asset and connect them to the file node
    let fileNodes = [];
    for (let asset of cacheEntry.assets) {
      let files = asset.connectedFiles.map(file => nodeFromFile(file));
      fileNodes = fileNodes.concat(files);
    }

    // Add a file node for the file that the transformer request resolved to
    fileNodes.push(nodeFromFile({filePath: req.filePath}));

    let assetNodes = cacheEntry.assets.map(asset => nodeFromAsset(asset));
    let {added, removed} = this.replaceNodesConnectedTo(requestNode, [
      ...assetNodes,
      ...fileNodes
    ]);

    let addedFiles = getFilesFromGraph(added);
    let removedFiles = getFilesFromGraph(removed);

    for (let assetNode of assetNodes) {
      let depNodes = assetNode.value.dependencies.map(dep => {
        return nodeFromDep(dep);
      });
      let {removed, added} = this.replaceNodesConnectedTo(assetNode, depNodes);
      removedFiles = removedFiles.concat(getFilesFromGraph(removed));
      newDepNodes = newDepNodes.concat(getDepNodesFromGraph(added));
    }

    for (let depNode of newDepNodes) {
      this.incompleteNodes.set(depNode.id, depNode);
    }

    let newDeps = newDepNodes.map(node => node.value);

    return {newDeps, addedFiles, removedFiles};
  }

  invalidateNode(node: Node) {
    this.invalidNodes.set(node.id, node);
  }

  invalidateFile(filePath: FilePath) {
    let node = this.getNode(filePath);
    if (!node || node.type !== 'file') {
      return;
    }

    // Invalidate all file nodes connected to this node.
    for (let connectedNode of this.getNodesConnectedTo(node)) {
      if (connectedNode.type === 'transformer_request') {
        this.invalidateNode(connectedNode);
      }
    }
  }

  getDependencies(asset: Asset): Array<IDependency> {
    let node = this.getNode(asset.id);
    if (!node) {
      return [];
    }

    return this.getNodesConnectedFrom(node).map(node => node.value);
  }

  getDependencyResolution(dep: IDependency): ?Asset {
    let depNode = this.getNode(dep.id);
    if (!depNode) {
      return null;
    }

    let res = null;
    this.traverse((node, ctx, traversal) => {
      if (node.type === 'asset' || node.type === 'asset_reference') {
        res = (node.value: Asset);
        traversal.stop();
      }
    }, depNode);

    return res;
  }

  traverseAssets(
    visit: GraphTraversalCallback<Asset, Node>,
    startNode: ?Node
  ): ?Node {
    return this.traverse((node, ...args) => {
      if (node.type === 'asset') {
        return visit(node.value, ...args);
      }
    }, startNode);
  }

  createBundle(asset: Asset): Bundle {
    let assetNode = this.getNode(asset.id);
    if (!assetNode) {
      throw new Error('Cannot get bundle for non-existant asset');
    }

    let graph = this.getSubGraph(assetNode);
    graph.setRootNode({
      type: 'root',
      id: 'root',
      value: null
    });

    graph.addEdge({from: 'root', to: assetNode.id});
    return {
      id: 'bundle:' + asset.id,
      type: asset.type,
      assetGraph: graph,
      env: asset.env
    };
  }

  getTotalSize(asset?: Asset): number {
    let size = 0;
    let assetNode = asset ? this.getNode(asset.id) : null;
    this.traverseAssets(asset => {
      size += asset.outputSize;
    }, assetNode);

    return size;
  }

  getEntryAssets(): Array<Asset> {
    let entries = [];
    this.traverseAssets((asset, ctx, traversal) => {
      entries.push(asset);
      traversal.skipChildren();
    });

    return entries;
  }

  removeAsset(asset: Asset) {
    let assetNode = this.getNode(asset.id);
    if (!assetNode) {
      return;
    }

    this.replaceNode(assetNode, {
      type: 'asset_reference',
      id: 'asset_reference:' + assetNode.id,
      value: asset
    });
  }
}