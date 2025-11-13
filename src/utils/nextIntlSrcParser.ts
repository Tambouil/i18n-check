import fs from 'node:fs';
import * as ts from 'typescript';

const USE_TRANSLATIONS = 'useTranslations';
const GET_TRANSLATIONS = 'getTranslations';
const COMMENT_CONTAINS_STATIC_KEY_REGEX = /t\((["'])(.*?[^\\])(["'])\)/;

// Global registry for functions with 't' parameter across all files
type FunctionWithTParam = {
  functionName: string;
  paramName: string;
  keysUsed: string[];
};
const globalFunctionsWithTParam: FunctionWithTParam[] = [];

export const extract = (filesPaths: string[]) => {
  // Reset global registry
  globalFunctionsWithTParam.length = 0;

  // Pass 1: Collect all functions with 't' parameter from all files
  filesPaths.forEach((path) => {
    collectFunctionsWithTParam(path);
  });

  // Pass 2: Extract keys from all files using the global registry
  return filesPaths.flatMap(getKeys).sort((a, b) => {
    return a.key > b.key ? 1 : -1;
  });
};

// Pass 1: Collect functions with 't' parameter from a file
const collectFunctionsWithTParam = (path: string) => {
  const content = fs.readFileSync(path, 'utf-8');
  const sourceFile = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    true
  );

  const visit = (node: ts.Node) => {
    // Track exported functions/schemas that accept 't' as parameter
    if (ts.isVariableDeclaration(node)) {
      if (
        node.initializer &&
        ts.isArrowFunction(node.initializer) &&
        node.initializer.parameters.length > 0
      ) {
        const firstParam = node.initializer.parameters[0];

        if (
          ts.isParameter(firstParam) &&
          firstParam.name &&
          ts.isIdentifier(firstParam.name) &&
          firstParam.type &&
          (ts.isFunctionTypeNode(firstParam.type) || ts.isTypeReferenceNode(firstParam.type))
        ) {
          const paramName = firstParam.name.text;
          const functionName = ts.isIdentifier(node.name) ? node.name.text : null;

          if (functionName) {
            const functionTracker: FunctionWithTParam = {
              functionName,
              paramName,
              keysUsed: [],
            };

            // Visit function body to find t('key') calls
            const visitFunctionBody = (bodyNode: ts.Node) => {
              if (
                ts.isCallExpression(bodyNode) &&
                ts.isIdentifier(bodyNode.expression) &&
                bodyNode.expression.text === paramName
              ) {
                const [argument] = bodyNode.arguments;
                if (argument && ts.isStringLiteral(argument)) {
                  functionTracker.keysUsed.push(argument.text);
                }
              }
              ts.forEachChild(bodyNode, visitFunctionBody);
            };

            if (node.initializer.body) {
              ts.forEachChild(node.initializer.body, visitFunctionBody);
            }

            if (functionTracker.keysUsed.length > 0) {
              globalFunctionsWithTParam.push(functionTracker);
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
};

// Pass 2: Extract keys from a file
const getKeys = (path: string) => {
  const content = fs.readFileSync(path, 'utf-8');
  const sourceFile = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    true
  );

  type Namespace = { name: string; variable: string; dynamic?: boolean };
  const foundKeys: {
    key: string;
    meta: { file: string; namespace?: string; dynamic?: boolean };
  }[] = [];
  let namespaces: Namespace[] = [];

  const getCurrentNamespaces = (range = 1) => {
    if (namespaces.length > 0) {
      return namespaces.slice(namespaces.length - range);
    }
    return null;
  };

  const getCurrentNamespaceForIdentifier = (name: string) => {
    return [...namespaces].reverse().find((namespace) => {
      return namespace.variable === name;
    });
  };

  const pushNamespace = (namespace: Namespace) => {
    namespaces.push(namespace);
  };

  const setNamespaceAsDynamic = (name: string) => {
    namespaces = namespaces.map((namespace) => {
      if (namespace.name === name) {
        return { ...namespace, dynamic: true };
      }
      return namespace;
    });
  };

  const removeNamespaces = (range = 1) => {
    if (namespaces.length > 0) {
      namespaces = namespaces.slice(0, namespaces.length - range);
    }
  };

  const visit = (node: ts.Node) => {
    let key: { name: string; identifier: string } | null = null;
    const initialNamespacesLength = namespaces.length;

    if (node === undefined) {
      return;
    }

    if (ts.isVariableDeclaration(node)) {
      if (node.initializer && ts.isCallExpression(node.initializer)) {
        if (ts.isIdentifier(node.initializer.expression)) {
          // Search for `useTranslations` calls and extract the namespace
          // Additionally check for assigned variable name, as it might differ
          // from the default `t`, i.e.: const other = useTranslations("namespace1");
          if (node.initializer.expression.text === USE_TRANSLATIONS) {
            const [argument] = node.initializer.arguments;

            const variable = ts.isIdentifier(node.name) ? node.name.text : 't';
            if (argument && ts.isStringLiteral(argument)) {
              pushNamespace({ name: argument.text, variable });
            } else if (argument === undefined) {
              pushNamespace({ name: '', variable });
            }
          }
        }
      }

      // Search for `getTranslations` calls and extract the namespace
      // There are two different ways `getTranslations` can be used:
      //
      // import {getTranslations} from 'next-intl/server';
      // const t = await getTranslations(namespace?);
      // const t = await getTranslations({locale, namespace});
      //
      // Additionally check for assigned variable name, as it might differ
      // from the default `t`, i.e.: const other = getTranslations("namespace1");
      // Simplified usage in async components
      if (node.initializer && ts.isAwaitExpression(node.initializer)) {
        if (
          ts.isCallExpression(node.initializer.expression) &&
          ts.isIdentifier(node.initializer.expression.expression)
        ) {
          if (
            node.initializer.expression.expression.text === GET_TRANSLATIONS
          ) {
            const [argument] = node.initializer.expression.arguments;
            const variable = ts.isIdentifier(node.name) ? node.name.text : 't';
            if (argument && ts.isObjectLiteralExpression(argument)) {
              argument.properties.forEach((property) => {
                if (
                  property &&
                  ts.isPropertyAssignment(property) &&
                  property.name &&
                  ts.isIdentifier(property.name) &&
                  property.name.text === 'namespace' &&
                  ts.isStringLiteral(property.initializer)
                ) {
                  pushNamespace({ name: property.initializer.text, variable });
                } else {
                  pushNamespace({ name: '', variable });
                }
              });
            } else if (argument && ts.isStringLiteral(argument)) {
              pushNamespace({ name: argument.text, variable });
            } else if (argument === undefined) {
              pushNamespace({ name: '', variable });
            }
          }
        }

        // Check if getTranslations is called inside a promise.all
        // Example:
        // const [data, t] = await Promise.all([
        //    loadData(id),
        //    getTranslations('asyncPromiseAll'),
        // ]);
        if (
          ts.isCallExpression(node.initializer.expression) &&
          node.initializer.expression.arguments.length > 0 &&
          ts.isArrayLiteralExpression(node.initializer.expression.arguments[0])
        ) {
          const functionNameIndex =
            node.initializer.expression.arguments[0].elements.findIndex(
              (argument) => {
                return (
                  ts.isCallExpression(argument) &&
                  ts.isIdentifier(argument.expression) &&
                  argument.expression.text === GET_TRANSLATIONS
                );
              }
            );

          // Try to find the correct function name via the position in the variable declaration
          if (
            functionNameIndex !== -1 &&
            ts.isArrayBindingPattern(node.name) &&
            ts.isBindingElement(node.name.elements[functionNameIndex]) &&
            ts.isIdentifier(node.name.elements[functionNameIndex].name)
          ) {
            const variable = node.name.elements[functionNameIndex].name.text;
            const [argument] = ts.isCallExpression(
              node.initializer.expression.arguments[0].elements[
                functionNameIndex
              ]
            )
              ? node.initializer.expression.arguments[0].elements[
                  functionNameIndex
                ].arguments
              : [];

            if (argument && ts.isObjectLiteralExpression(argument)) {
              argument.properties.forEach((property) => {
                if (
                  property &&
                  ts.isPropertyAssignment(property) &&
                  property.name &&
                  ts.isIdentifier(property.name) &&
                  property.name.text === 'namespace' &&
                  ts.isStringLiteral(property.initializer)
                ) {
                  pushNamespace({ name: property.initializer.text, variable });
                }
              });
            } else if (argument && ts.isStringLiteral(argument)) {
              pushNamespace({ name: argument.text, variable });
            } else if (argument === undefined) {
              pushNamespace({ name: '', variable });
            }
          }
        }
      }
    }

    // Detect calls to functions with 't' parameter: mySchema(t) or mySchema(useTranslations('Namespace'))
    // Uses global registry collected in Pass 1
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression)) {
        const calledFunctionName = node.expression.text;
        const trackedFunction = globalFunctionsWithTParam.find(
          (f) => f.functionName === calledFunctionName
        );

        if (trackedFunction && node.arguments.length > 0) {
          const [argument] = node.arguments;

          // Pattern 1: Direct call with useTranslations('Namespace')
          if (
            ts.isCallExpression(argument) &&
            ts.isIdentifier(argument.expression) &&
            argument.expression.text === USE_TRANSLATIONS
          ) {
            const [namespaceArg] = argument.arguments;
            if (namespaceArg && ts.isStringLiteral(namespaceArg)) {
              const namespace = namespaceArg.text;

              // Add all keys used in that function with the namespace
              trackedFunction.keysUsed.forEach((keyName) => {
                foundKeys.push({
                  key: namespace ? `${namespace}.${keyName}` : keyName,
                  meta: { file: path, namespace },
                });
              });
            }
          }

          // Pattern 2: Call with variable: mySchema(t) where t = useTranslations('Namespace')
          if (ts.isIdentifier(argument)) {
            const variableName = argument.text;
            const namespace = getCurrentNamespaceForIdentifier(variableName);

            if (namespace) {
              // Add all keys used in that function with the namespace
              trackedFunction.keysUsed.forEach((keyName) => {
                foundKeys.push({
                  key: namespace.name ? `${namespace.name}.${keyName}` : keyName,
                  meta: { file: path, namespace: namespace.name },
                });
              });
            }
          }
        }
      }
    }

    // Search for direct inline calls and extract namespace and key
    //
    // useTranslations("ns1")("one")
    // useTranslations("ns1").rich("one");
    // useTranslations("ns1").raw("one");
    if (ts.isExpressionStatement(node)) {
      let inlineNamespace = null;
      if (node.expression && ts.isCallExpression(node.expression)) {
        // Search: useTranslations("ns1")("one")
        if (
          ts.isCallExpression(node.expression.expression) &&
          ts.isIdentifier(node.expression.expression.expression)
        ) {
          if (node.expression.expression.expression.text === USE_TRANSLATIONS) {
            const [argument] = node.expression.expression.arguments;
            if (argument && ts.isStringLiteral(argument)) {
              inlineNamespace = argument.text;
            }
          }
        }
        // Search: useTranslations("ns1").*("one")
        if (
          ts.isPropertyAccessExpression(node.expression.expression) &&
          ts.isCallExpression(node.expression.expression.expression) &&
          ts.isIdentifier(node.expression.expression.expression.expression)
        ) {
          if (
            node.expression.expression.expression.expression.text ===
            USE_TRANSLATIONS
          ) {
            const [argument] = node.expression.expression.expression.arguments;
            if (argument && ts.isStringLiteral(argument)) {
              inlineNamespace = argument.text;
            }

            const [callArgument] = node.expression.arguments;
            if (callArgument && ts.isStringLiteral(callArgument)) {
              const key = callArgument.text;
              if (key) {
                foundKeys.push({
                  key: inlineNamespace ? `${inlineNamespace}.${key}` : key,
                  meta: { file: path, namespace: inlineNamespace ?? undefined },
                });
              }
            }
          }
        }
      }
    }

    // Search for `t()` calls
    if (
      getCurrentNamespaces() !== null &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression)
    ) {
      const expressionName = node.expression.text;
      const namespace = getCurrentNamespaceForIdentifier(expressionName);
      if (namespace) {
        const [argument] = node.arguments;
        if (argument && ts.isStringLiteral(argument)) {
          key = { name: argument.text, identifier: expressionName };
        } else if (argument && ts.isIdentifier(argument)) {
          setNamespaceAsDynamic(namespace.name);
        } else if (argument && ts.isTemplateExpression(argument)) {
          setNamespaceAsDynamic(namespace.name);
        }
      }
    }

    // Search for `t.*()` calls, i.e. t.html() or t.rich()
    if (
      getCurrentNamespaces() !== null &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression)
    ) {
      const expressionName = node.expression.expression.text;
      const namespace = getCurrentNamespaceForIdentifier(expressionName);
      if (namespace) {
        const [argument] = node.arguments;
        if (argument && ts.isStringLiteral(argument)) {
          key = { name: argument.text, identifier: expressionName };
        } else if (argument && ts.isIdentifier(argument)) {
          setNamespaceAsDynamic(namespace.name);
        } else if (argument && ts.isTemplateExpression(argument)) {
          setNamespaceAsDynamic(namespace.name);
        }
      }
    }

    if (key) {
      const namespace = getCurrentNamespaceForIdentifier(key.identifier);
      const namespaceName = namespace ? namespace.name : '';
      foundKeys.push({
        key: namespaceName ? `${namespaceName}.${key.name}` : key.name,
        meta: { file: path, namespace: namespaceName },
      });
    }

    // Search for single-line comments that contain the static values of a dynamic key
    // Example:
    // const someKeys = messages[selectedOption];
    // Define as a single-line comment all the possible static keys for that dynamic key
    // t('some.static.key.we.want.to.extract');
    // t('some.other.key.we.want.to.extract.without.semicolons')
    const commentRanges = ts.getLeadingCommentRanges(
      sourceFile.getFullText(),
      node.getFullStart()
    );

    if (commentRanges?.length && commentRanges.length > 0) {
      commentRanges.forEach((range) => {
        const comment = sourceFile.getFullText().slice(range.pos, range.end);
        // parse the string and check if it includes the following format:
        // t('someString')
        const hasStaticKeyComment =
          COMMENT_CONTAINS_STATIC_KEY_REGEX.test(comment);

        if (hasStaticKeyComment) {
          // capture the string comment
          const commentKey =
            COMMENT_CONTAINS_STATIC_KEY_REGEX.exec(comment)?.[2];
          if (commentKey) {
            const namespace = getCurrentNamespaces();
            const namespaceName = namespace ? namespace[0]?.name : '';

            foundKeys.push({
              key: namespaceName
                ? `${namespaceName}.${commentKey}`
                : commentKey,
              meta: { file: path, namespace: namespaceName },
            });
          }
        }
      });
    }

    ts.forEachChild(node, visit);

    if (
      ts.isFunctionLike(node) &&
      namespaces.length > initialNamespacesLength
    ) {
      // check if the namespaces are dynamic and add a placeholder key
      const currentNamespaces = getCurrentNamespaces(
        namespaces?.length - initialNamespacesLength
      );

      currentNamespaces?.forEach((namespace) => {
        if (namespace.dynamic) {
          foundKeys.push({
            key: namespace.name,
            meta: { file: path, namespace: namespace.name, dynamic: true },
          });
        }
      });

      removeNamespaces(namespaces.length - initialNamespacesLength);
    }
  };

  ts.forEachChild(sourceFile, visit);

  return foundKeys;
};
