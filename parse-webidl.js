var WebIDL2 = require("webidl2");


/**
 * Main method that takes IDL definitions and parses that IDL to compute
 * the list of internal/external dependencies.
 *
 * @function
 * @public
 * @param {String} idl IDL content, typically returned by the WebIDL extractor
 * @return {Promise} The promise to a parsed IDL structure that includes
 *   information about dependencies, both at the interface level and at the
 *   global level.
 */
function parse(idl) {
    return new Promise(function (resolve, reject) {
        var idlTree;
        var jsNames = {constructors: {}, functions: {}, objects:{}};
        var idlNames = {_dependencies: {}};
        var idlExtendedNames = {};
        var localNames= {};
        var externalDependencies = [];
        try {
            idlTree = WebIDL2.parse(idl);
        } catch (e) {
            return reject(e);
        }
        idlTree.forEach(parseIdlAstTree(jsNames, idlNames, idlExtendedNames, localNames, externalDependencies));
        externalDependencies = externalDependencies.filter(n => !idlNames[n] && !localNames[n]);
        resolve({jsNames, idlNames, idlExtendedNames, localNames, externalDependencies});
    });
}


/**
 * Function that generates a parsing method that may be applied to nodes of
 * the IDL AST tree generated by the webidl2 and that completes the tree
 * structure with dependencies information.
 *
 * Note that the method recursively calls itself when it parses interfaces or
 * dictionaries.
 *
 * @function
 * @private
 * @param {Object} jsNames The set of interfaces that are visible from the
 *   JavaScript code, per context, either through Constructors or because they
 *   are exposed by some function or object.
 * @param {Object} idlNames The set of interfaces and other constructs that the
 *   IDL content defines.
 * @param {Object} idlExtendedNames The set of interfaces that the
 *   IDL content extends, typically through "partial" definitions
 * @param {Object} localNames
 * @param {Array(String)} externalDependencies The set of IDL names that the IDL
 *   content makes use of and that it does not define
 * @param {String} contextName The current interface context, used to compute
 *   dependencies at the interface level
 * @return A function that can be applied to all nodes of an IDL AST tree and
 *   that fills up the above sets.
 */
function parseIdlAstTree(jsNames, idlNames,idlExtendedNames, localNames, externalDependencies, contextName) {
    return function (def) {
        switch(def.type) {
        case "interface":
        case "dictionary":
        case "callback interface":
            parseInterfaceOrDictionary(def, jsNames, idlNames, idlExtendedNames, localNames, externalDependencies);
            break;
        case "enum":
            idlNames[def.name] = def;
            break;
        case "operation":
            if (def.stringifier) return;
            parseType(def.idlType, idlNames, localNames, externalDependencies, contextName);
            def.arguments.forEach(a => parseType(a.idlType,  idlNames, localNames, externalDependencies, contextName));
            break;
        case "attribute":
        case "field":
            parseType(def.idlType, idlNames, localNames, externalDependencies, contextName);
            break;
        case "implements":
            parseType(def.target, idlNames, localNames, externalDependencies);
            parseType(def.implements, idlNames, localNames, externalDependencies);
            if (!idlNames._dependencies[def.target]) {
                idlNames._dependencies[def.target] = [];
            }
            addDependency(def.implements, {}, idlNames._dependencies[def.target]);
            break;
        case "typedef":
            parseType(def.idlType, idlNames, localNames, externalDependencies);
            localNames[def.name] = def;
            break;
        case "callback":
            localNames[def.name] = def;
            def.arguments.forEach(a => parseType(a.idlType,  idlNames, localNames, externalDependencies));
            break;
        case "iterable":
        case "setlike":
        case "maplike":
            var type = def.idlType;
            if (!Array.isArray(type)) {
                type = [def.idlType];
            }
            type.forEach(a => parseType(a, idlNames, localNames, externalDependencies, contextName));
            break;
        case "serializer":
        case "stringifier":
        case "const":
            break;
        default:
            console.error("Unhandled IDL type: " + def.type + " in " +JSON.stringify(def));
        }
    };
}


/**
 * Parse an IDL AST node that defines an interface or dictionary, and compute
 * dependencies information.
 *
 * @function
 * @private
 * @param {Object} def The IDL AST node to parse
 * @see parseIdlAstTree for other parameters
 * @return {void} The function updates the contents of its parameters and does
 *   not return anything
 */
function parseInterfaceOrDictionary(def, jsNames, idlNames, idlExtendedNames, localNames, externalDependencies) {
    if (!idlNames._dependencies[def.name]) {
        idlNames._dependencies[def.name] = [];
    }
    if (def.partial) {
        if (!idlExtendedNames[def.name]) {
            idlExtendedNames[def.name] = [];
        }
        idlExtendedNames[def.name].push(def);
        addDependency(def.name, idlNames, externalDependencies);
    } else {
        if (def.inheritance) {
            addDependency(def.inheritance, idlNames, externalDependencies);
            addDependency(def.inheritance, {}, idlNames._dependencies[def.name]);
        }
        idlNames[def.name] = def;
        if (def.extAttrs.filter(ea => ea.name === "Constructor").length) {
            addToJSContext(def.extAttrs, jsNames, def.name, "constructors");
            def.extAttrs.filter(ea => ea.name === "Constructor").forEach(function(constructor) {
                if (constructor.arguments) {
                    constructor.arguments.forEach(a => parseType(a.idlType, idlNames, localNames, externalDependencies));
                }
            });
        } else if (def.extAttrs.filter(ea => ea.name === "NamedConstructor").length) {
            def.extAttrs.filter(ea => ea.name === "NamedConstructor").forEach(function(constructor) {
                idlNames[constructor.rhs.value] = constructor;
                addToJSContext(def.extAttrs, jsNames, def.name, "constructors");
                if (constructor.arguments) {
                    constructor.arguments.forEach(a => parseType(a.idlType, idlNames, localNames, externalDependencies));
                }
            });
        } else if (def.type === "interface") {
            if (!def.extAttrs.filter(ea => ea.name === "NoInterfaceObject").length) {
                addToJSContext(def.extAttrs, jsNames, def.name, "functions");
            }
        }
    }
    def.members.forEach(parseIdlAstTree(jsNames, idlNames, idlExtendedNames, localNames, externalDependencies, def.name));
}


/**
 * Add the given IDL name to the set of objects that are exposed to JS, for the
 * right contexts.
 *
 * @function
 * @private
 * @param {Object} eas The extended attributes that may qualify that IDL name
 * @param {Object} jsNames See parseIdlAstTree params
 * @param {String} name The IDL name to add to the jsNames set
 * @param {String} type The type of exposure (constructor, function, object)
 * @return {void} The function updates jsNames
 */
function addToJSContext(eas, jsNames, name, type) {
    var contexts = ["Window"];
    var exposed = eas && eas.filter(ea => ea.name === "Exposed").length;
    if (exposed) {
        var exposedEa = eas.filter(ea => ea.name === "Exposed")[0];
        if (exposedEa.rhs.type === "identifier") {
            contexts = [exposedEa.rhs.value];
        } else {
            contexts = exposedEa.rhs.value;
        }
    }
    contexts.forEach(c => { if (!jsNames[type][c]) jsNames[type][c] = []; jsNames[type][c].push(name)});
}


/**
 * Parse the given IDL type and update external dependencies accordingly
 *
 * @function
 * @private
 * @param {Object} idltype The IDL AST node that defines/references the type
 * @see parseIdlAstTree for other parameters
 * @return {void} The function updates externalDependencies
 */
function parseType(idltype, idlNames, localNames, externalDependencies, contextName) {
    // For some reasons, webidl2 sometimes returns the name of the IDL type
    // instead of an IDL construct for array constructs. For example:
    //  Constructor(DOMString[] urls) interface toto;
    // ... will create an array IDL node that directly point to "DOMString" and
    // not to a node that describes the "DOMString" type.
    if (isString(idltype)) {
        idltype = { idlType: 'DOMString' };
    }
    if (idltype.union) {
        idltype.idlType.forEach(t => parseType(t, idlNames, localNames, externalDependencies));
        return;
    }
    if (idltype.sequence || idltype.array || idltype.generic) {
        parseType(idltype.idlType, idlNames, localNames, externalDependencies);
        return;
    }
    var wellKnownTypes = ["void", "any", "boolean", "byte", "octet", "short", "unsigned short", "long", "unsigned long", "long long", "unsigned long long", "float", "unrestricted float", "double", "unrestricted double", "DOMString", "ByteString", "USVString", "object",
                          "RegExp", "Error", "DOMException", "ArrayBuffer", "DataView", "Int8Array", "Int16Array", "Int32Array", "Uint8Array", "Uint16Array", "Uint32Array", "Uint8ClampedArray", "Float32Array", "Float64Array",
                          "ArrayBufferView", "BufferSource", "DOMTimeStamp", "Function", "VoidFunction"];
    if (wellKnownTypes.indexOf(idltype.idlType) === -1) {
        addDependency(idltype.idlType, idlNames, externalDependencies);
        if (contextName) {
            addDependency(idltype.idlType, {}, idlNames._dependencies[contextName]);
        }
    }
}


/**
 * Returns true if given object is a String
 *
 * @function
 * @private
 * @param {any} obj The object to test
 * @return {bool} true is object is a String, false otherwise
 */
function isString(obj) {
    return Object.prototype.toString.call(obj) === '[object String]';
}


/**
 * Add the given name to the list of external dependencies, unless it already
 * appears in the set of IDL names defined by the IDL content
 *
 * @function
 * @private
 * @param {String} name The IDL name to consider as a potential external dependency
 * @param {Array(String)} externalDependencies The set of external dependencies
 * @return {void} The function updates externalDependencies as needed
 */
function addDependency(name, idlNames, externalDependencies) {
    if ((Object.keys(idlNames).indexOf(name) === -1) &&
        (externalDependencies.indexOf(name) === -1)) {
        externalDependencies.push(name);
    }
}


/**************************************************
Export the parse method for use as module
**************************************************/
module.exports.parse = parse;


/**************************************************
Code run if the code is run as a stand-alone module
**************************************************/
if (require.main === module) {
    var url = process.argv[2];
    if (!url) {
        console.error("Required URL parameter missing");
        process.exit(2);
    }
    var webidlExtract = require("./extract-webidl");
    webidlExtract.extract(url)
        .then(parse)
        .then(function (data) {
            console.log(JSON.stringify(data, null, 2));
        })
        .catch(function (err) {
            console.error(err.stack);
            process.exit(64);
        });
}