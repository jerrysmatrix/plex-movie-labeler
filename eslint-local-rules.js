/**
 * Local ESLint rules for this repo.
 */

/** @type {import('eslint').Rule.RuleModule} */
const magneticVarsRule = {
	meta: {
		type: 'suggestion',
		docs: {
			description: 'Merge consecutive variable declarations of the same kind only when there is no blank line between them.'
		},
		fixable: 'code',
		schema: [],
		messages: {
			merge: "Magnetize with previous '{{kind}}' declaration (no blank line between)."
		}
	},
	create(context) {
		const sourceCode = context.sourceCode;

		function hasBlankLineBetween(a, b) {
			const between = sourceCode.text.slice(a.range[1], b.range[0]);
			return /\n\s*\n/.test(between);
		}

		function checkList(body) {
			for (let i = 1; i < body.length; i += 1) {
				const prev = body[i - 1],
					curr = body[i];

				if (
					prev &&
					curr &&
					prev.type === 'VariableDeclaration' &&
					curr.type === 'VariableDeclaration' &&
					prev.kind === curr.kind &&
					!hasBlankLineBetween(prev, curr)
				) {
					context.report({
						node: curr,
						messageId: 'merge',
						data: { kind: curr.kind },
						fix(fixer) {
							const prevText = sourceCode.getText(prev),
								currDecls = curr.declarations.map((d) => sourceCode.getText(d)).join(', ');

							// Strip trailing semicolon and whitespace from previous declaration
							const prevNoSemi = prevText.replace(/;\s*$/, ''),
								combined = `${prevNoSemi}, ${currDecls};`;

							return fixer.replaceTextRange([prev.range[0], curr.range[1]], combined);
						}
					});
				}
			}
		}

		return {
			Program(node) {
				checkList(node.body);
			},
			BlockStatement(node) {
				checkList(node.body);
			}
		};
	}
};

module.exports = {
	rules: {
		'magnetic-vars': magneticVarsRule
	}
};
