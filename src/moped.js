/* Moped = Modular Page Editor, or somesuch. ;-) */
const fs = require('fs');
const path = require('path');
const nodeDir = require('node-dir');
const { parse, stringify } = require('html-parse-stringify');


/* Environment Variables */
const BUILD_DIR = process.env.MOPED_BUILD_DIR;
const HTML_DIR = process.env.MOPED_HTML_DIR;
const MODULES_DIR = process.env.MOPED_MODULES_DIR;


/* Very simple Logging, needs a better solution */
const logLevel = 'INFO'; // 'WARN'; // 
function logInfo(msg) { if (logLevel === 'INFO') { console.log(`INFO: ${msg}`); } }
function logWarning(msg) { console.log(`WARNING: ${msg}`); }
function logWarning(msg) { console.log(`WARNING: ${msg}`); }

const { HTML_RESERVED_TAGS } = require('./html_reserved_tags');
const HTML5_DOCTYPE = "<!DOCTYPE html>";


const DEFAULT_CHILD_GROUP = "ungrouped";
const TEXT_NODE_WHITESPACE_ONLY = /^[ \t\n\r]*$/;

let mods = {};

function findModuleFiles() {
    let knownModules = {};
    logInfo(`Finding HTML module files in ${MODULES_DIR}`);
    const files = nodeDir.files(MODULES_DIR, { sync: true });
    files.forEach(mod_file => {
        if (path.extname(mod_file) === '.html') {
            tag = path.basename(mod_file, ".html");
            if (HTML_RESERVED_TAGS.includes(tag)) {
                logWarning(`Ignoring module with a reserved HTML tag name: ${tag} (${mod_file})`);
            } else {
                logInfo(`Discovered module ${tag} (${mod_file})`);
                knownModules[path.basename(mod_file, '.html')] = path.resolve(mod_file);
            }
        }
    });
    return knownModules;
}

function loadAndParseFile(fname) {
    const html = fs.readFileSync(fname, 'utf8');
    const node = parse(html);
    return node;
}

function loadModule(name, inheritedChildren, substitutions, nodePath) {
    const loaded = loadAndParseFile(mods[name]);
    const expanded = expandNodes(loaded, inheritedChildren, substitutions, `${nodePath}:(${name})`);
    return expanded;
}

const SUBST_TAG_REGEX = /{{(dc-[a-zA-Z0-9._-]*)}}/;

function verifyChildrenObject(children) {
    /* null is okay, else it must be an object where every property is an array */
    if (children) {
        const nonArrayProp = Object.entries(children).find(e => !Array.isArray(e[1]));
        if (nonArrayProp) {
            throw "expandNodes expects children to be null, or an object where every property contains an array of node objects";
        }
    }
}


function expandNodes(nodes, children = null, substitutions = null, nodePath = "") {
    if (!Array.isArray(nodes)) throw "expandNodes expects an array of node objects";
    verifyChildrenObject(children);
    let expanded = [];

    for (const node of nodes) {
        if (node.type === "tag") {
            logInfo(`Processing node [${node.name}] in [${nodePath}]`);
            let newSubs = null;
            if (node.attrs) {
                /* first, substitute for any variables we already know */
                if (substitutions) {
                    const allKeys = Object.keys(node.attrs);
                    allKeys.forEach(key => {
                        while (true) {
                            const lastValue = node.attrs[key];
                            const matches = lastValue.match(SUBST_TAG_REGEX);
                            if (matches) {
                                // logInfo(`Found substitution placeholder: ${matches[1]}`);
                                if (substitutions.hasOwnProperty(matches[1])) {
                                    node.attrs[key] = node.attrs[key].replaceAll(matches[0], substitutions[matches[1]]);
                                }
                            }
                            /* stop replacing if we made no change */
                            if (lastValue === node.attrs[key]) { break; }
                        }
                    });
                }
                /* extract any variables defined here */
                const pairs = Object.entries(node.attrs).filter(e => e[0].startsWith("dc-"));
                if (pairs.length == 0) {
                    /* If there are none, we can just pass on the same substitutions object */
                    newSubs = substitutions;
                } else {
                    /*otherwise we create a new object, including all of the existing substitutions */
                    newSubs = { ...substitutions, ...Object.fromEntries(pairs) };
                }
            }
            if (node.name === "children") {
                if (children) {
                    /* If this is a tag called "children", then we expand here the children array passed from the most recent enclosing layer */
                    if (Array.isArray(node.children) && node.children.length > 0) {
                        logWarning("'children' node found with children of its own - these will not be included (cos it makes no sense)");
                    }
                    /* If this children tag has no group tag, we expand it using the default tag. */
                    grpName = (node.attrs && node.attrs["group"]) || DEFAULT_CHILD_GROUP;
                    /* Catch potential typos in attribute names. */
                    unknownAttrs = node.attrs && Object.keys(node.attrs).filter(a => false === ["group", "optional"].includes(a));
                    if (unknownAttrs && unknownAttrs.length > 0) {
                        logWarning(`children tag has unknown attributes [${unknownAttrs.join()}] at [${nodePath}]`);
                    }
                    // logInfo(`Processing children node, expecting group [${grpName}] at [$${nodePath}]`);
                    // logInfo(`Available child groups [${Object.keys(children).join()}] `);
                    if (children.hasOwnProperty(grpName)) {
                        // logInfo(`Consuming child group [${grpName}] at [$${nodePath}]`);
                        childSubset = children[grpName];
                        delete children[grpName];
                        const newKids = expandNodes(childSubset, null, newSubs, `${nodePath}:[child-group=${grpName}]`);
                        if (newKids.find(d => !d)) { throw `undefined child in response for children group [${grpName}]`; }
                        if (grpName !== DEFAULT_CHILD_GROUP) { newKids.forEach(n => delete n.attrs["child-group"]); }
                        expanded.push(...newKids);
                    } else if (grpName !== DEFAULT_CHILD_GROUP && !Object.keys(node.attrs).includes("optional")) {
                        logWarning(`'children' group '${grpName}' has no nodes and cannot be expanded, at [${nodePath}]`);
                    }
                }
            } else if (mods.hasOwnProperty(node.name)) {
                /* If this tag is defined in a module file, import that and replace the tag */

                /* We pass on all named child groups, unless there is a new doctype with that name at this level, in which case that "hides" the original. */
                const originalGroups = children ? Object.keys(children).filter(n => n !== DEFAULT_CHILD_GROUP) : [];
                let childrenToPassOn = {};
                if (node.children) {
                    /* Pre-process the children nodes looking for the tag "child-group". For each one we find, replace it with all of its children, and add/ovewrite their child-group attribute. */
                    for (let i = 0; i < node.children.length;) {
                        const child = node.children[i];
                        if (child.name === "child-group") {
                            let childGroup = [];
                            if (!child.attrs || !child.attrs["group"]) {
                                logError("child-group tag without group attribute - this whole section cannot be rendered");
                            } else if (!Array.isArray(child.children) || child.children.length == 0) {
                                logWarning("child-group tag without any children, possible bug?");
                            } else {
                                const grpName = child.attrs["group"];
                                child.children.forEach(ch => {
                                    if (nonEmptyTextNode(ch)) {
                                        logWarning(`Child group [${grpName}] cannot contain text at the top level: wrap it in a <span> or other tag.`)
                                    } else if (ch.type === 'tag') {
                                        ch.attrs["child-group"] = grpName;
                                        childGroup.push(ch);
                                    }
                                });
                            }
                            /* remove this node */
                            node.children.splice(i, 1);
                            /* insert the selected children */
                            childGroup.forEach(n => { node.children.splice(i, 0, n); i++; })
                        } else {
                            i++;
                        }
                    }
                    /* Now process the children, potentially flattened by the above pre-process */
                    node.children.forEach(n => {
                        grpName = (n.attrs && n.attrs["child-group"]) || DEFAULT_CHILD_GROUP;
                        childrenToPassOn[grpName] = childrenToPassOn[grpName] ? [...childrenToPassOn[grpName], n] : [n];
                        if (originalGroups.includes(grpName)) {
                            originalGroups.splice(originalGroups.indexOf(grpName), 1);
                        }
                    });
                }
                const newGroups = Object.keys(childrenToPassOn);
                if (newGroups && newGroups.length > 0) { logInfo(`found child groups [${newGroups.join()}]`); }
                originalGroups.forEach(g => { if (!childrenToPassOn[g]) { childrenToPassOn[g] = children[g]; } });
                /* Named groups get used as soon as they are referenced, but any left over from the original child group */
                // logInfo(`Importing module tag <${node.name}>`);
                const mod = loadModule(node.name, childrenToPassOn, newSubs, nodePath);
                if (!Array.isArray(mod) || mod.find(e => !e)) { throw `undefined or null node in response for module [${node.name}]`; }
                expanded.push(...mod);
                /* remove any original groups that were used up */
                originalGroups.forEach(g => { if (!childrenToPassOn[g]) { delete children[g]; } });
                /* Warn if any new groups were NOT used */
                if (newGroups && newGroups.length > 0) {
                    var setGrps = new Set(newGroups);
                    if (Object.keys(childrenToPassOn).find(x => setGrps.has(x))) {
                        const unconsumed = Object.keys(childrenToPassOn).filter(x => setGrps.has(x));
                        /* It is an error unless the only group is the default group, and it only contains whitespace */
                        if (unconsumed && Array.isArray(unconsumed) && unconsumed.length == 1 && unconsumed[0] === DEFAULT_CHILD_GROUP) {
                            if (childrenToPassOn[DEFAULT_CHILD_GROUP].find(n => nonEmptyTextNode(n) || (n.type == "tag" && n.name !== "children"))) {
                                logWarning(`leftover non-whitespace child nodes processing [${nodePath}]`);
                            }
                        } else {
                            logWarning(`leftover child groups [${unconsumed.join()}] processing [${nodePath}]`);
                        }
                    }
                }
            } else {
                /* If this tag is not a module name, then just expand its child nodes if any */
                if (Array.isArray(node.children) && node.children.length > 0) {
                    // logInfo(`Expanding children nodes`);
                    const realKids = node.children.filter(n => n.type === 'tag' || nonEmptyTextNode(n));
                    const expandedKids = expandNodes(realKids, children, newSubs, `${nodePath}:${node.name}`);
                    if (expandedKids.find(d => !d)) { throw `undefined node expanding hildren in node [${node.name}]`; }
                    node.children = expandedKids;
                }
                expanded.push(node);
            }
        } else if (nonEmptyTextNode(node)) {
            /* Substitute variables in the node text */
            while (substitutions) {
                const lastValue = node.content;
                const matches = lastValue.match(SUBST_TAG_REGEX);
                if (matches) {
                    // logInfo(`Found substitution placeholder: ${matches[1]}`);
                    if (substitutions.hasOwnProperty(matches[1])) {
                        node.content = node.content.replaceAll(matches[0], substitutions[matches[1]]);
                    }
                }
                /* stop replacing if we made no change */
                if (lastValue === node.content) { break; }
            }
            node.content = node.content.trim();
            expanded.push(node);

        }
    }
    return expanded;
}

function nonEmptyTextNode(node) { return node && node.type === "text" && !TEXT_NODE_WHITESPACE_ONLY.test(node.content); }
function emptyTextNode(node) { return node && node.type === "text" && TEXT_NODE_WHITESPACE_ONLY.test(node.content); }
function reservedHtmlTag(tag) { return tag && HTML_RESERVED_TAGS.includes(tag); }

/**
 * Read each of the files in the HTML_DIR (no recursion), parse it,
 * and recursively expand each custom tag by looking for a module file with the same name.
 */
function processHtml() {
    const htmlFiles = fs.readdirSync(HTML_DIR);
    htmlFiles.forEach(f => {
        if (path.extname(f) === '.html') {
            let hasDocType = false;
            fname = path.resolve(HTML_DIR, f);
            let html = fs.readFileSync(fname, 'utf8');
            if (html.startsWith(HTML5_DOCTYPE)) {
                hasDocType = true;
                html = html.substr(HTML5_DOCTYPE.length);
            }
            const raw_nodes = parse(html);
            /* Call into the node-expansion recursive function.
             * children is a map of named node arrays, collected from child-group tags and later used to replace children tags
             * substitutions is a map of key-value pairs, collected from attributes in custom tags and used to replace placeholders, indicated by double-braces.
             * Initilly these are both empty, since we have no processed anything yet.
             * nodePath is a collected string of the processed path, used for debugging.
             */
            const children = null;
            const substitutions = null;
            const nodePath = f;
            const expanded = expandNodes(raw_nodes, children, substitutions, nodePath);
            const output = (hasDocType ? HTML5_DOCTYPE + "\n" : "") + stringify(expanded);
            fs.writeFileSync(`${BUILD_DIR}/${path.basename(f)}`, output);
        }
    });
}

function main() {
    if (!MODULES_DIR) {
        throw "No value specified for Modules directory (env var = MOPED_MODULES_DIR)";
    }
    if (!HTML_DIR) {
        throw "No value specified for HTML entrypoints directory (env var = MOPED_HTML_DIR)";
    }
    if (!BUILD_DIR) {
        throw "No value specified for build output directory (env var = MOPED_BUILD_DIR)";
    }
    mods = findModuleFiles();
    fs.mkdir(BUILD_DIR, { recursive: true }, err => {/* Ignore errors */ });
    processHtml();
}

module.exports = { main };
