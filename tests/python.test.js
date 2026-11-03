import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzePython} from '../src/python.js';

const parse = code => analyzePython(code, 'example.py');
const symbol = (model, qualifiedName) => model.symbols.find(item => item.qualifiedName === qualifiedName);
const targets = item => item.calls.filter(call => call.targetId).map(call => call.targetId);

test('Python nested functions have distinct scoped identities and no return leakage', () => {
  const code = `def helper(value):
    return value * 2

def outer(value):
    """Coordinate two steps."""
    def helper(value):
        return value + 1
    return helper(value)

outer(2)
`;
  const model = parse(code), outer = symbol(model, 'outer'), nested = symbol(model, 'outer.helper');
  assert.equal(outer.docstring, 'Coordinate two steps.');
  assert.equal(nested.ownerId, outer.id);
  assert.deepEqual(outer.returns, ['helper(value)']);
  assert.deepEqual(nested.returns, ['value + 1']);
  assert.deepEqual(targets(outer), [nested.id]);
  assert.equal(nested.chunkId, outer.chunkId);
  assert.equal(model.chunks.length, 3);
  assert.equal(model.highlights.filter(item => item.symbolId === nested.id).length, 1);
  for (let index = 1; index < model.chunks.length; index++) assert.ok(model.chunks[index - 1].end <= model.chunks[index].start);
});

test('Python class methods link self, cls, and explicit class calls without merging names', () => {
  const model = parse(`def finish(value):
    return value

class First:
    @classmethod
    def build(cls, value):
        return cls.finish(value)
    def run(self, value):
        return self.finish(value)
    def finish(self, value):
        return finish(value)

class Second:
    @staticmethod
    def finish(value):
        return value + 1

First.finish(None, 2)
Second.finish(3)
`);
  const firstFinish = symbol(model, 'First.finish'), secondFinish = symbol(model, 'Second.finish');
  assert.deepEqual(targets(symbol(model, 'First.build')), [firstFinish.id]);
  assert.deepEqual(targets(symbol(model, 'First.run')), [firstFinish.id]);
  assert.deepEqual(targets(firstFinish), [symbol(model, 'finish').id]);
  assert.deepEqual(model.chunks.at(-2).calls.map(call => call.targetId), [firstFinish.id]);
  assert.deepEqual(model.chunks.at(-1).calls.map(call => call.targetId), [secondFinish.id]);
  assert.equal(firstFinish.className, 'First');
  assert.deepEqual(symbol(model, 'First.build').decorators, ['@classmethod\n']);
  assert.equal(model.chunks[1].kind, 'class');
});

test('a class method cannot see sibling methods as unqualified lexical names', () => {
  const model = parse(`def helper():
    return 1
class Worker:
    def helper(self):
        return 2
    def run(self):
        return helper()
`);
  assert.deepEqual(targets(symbol(model, 'Worker.run')), [symbol(model, 'helper').id]);
});

test('receiver reassignment and unknown instances do not produce method dependencies', () => {
  const model = parse(`class Worker:
    def helper(self):
        return 1
    def run(self, other):
        self = other
        return self.helper()

def main(worker):
    return worker.helper()
`);
  assert.deepEqual(targets(symbol(model, 'Worker.run')), []);
  assert.deepEqual(targets(symbol(model, 'main')), []);
});

test('Python preserves full positional, keyword-only, annotated, and variadic signatures', () => {
  const model = parse(`async def run(a: dict[str, int], /, b=(1, 2), *args, flag="a,b", **kwargs):
    return await work(a)

def work(value):
    return value
`), run = symbol(model, 'run');
  assert.equal(run.async, true);
  assert.deepEqual(run.params, ['a: dict[str, int]', '/', 'b=(1, 2)', '*args', 'flag="a,b"', '**kwargs']);
  assert.deepEqual([...run.locals], ['a', 'b', 'args', 'flag', 'kwargs']);
  assert.deepEqual(run.returns, ['await work(a)']);
  assert.deepEqual(targets(run), [symbol(model, 'work').id]);
});

for (const [label, body] of [
  ['destructuring assignment', '    left, (helper, *rest) = values\n    return helper()'],
  ['chained assignment', '    other = helper = callback\n    return helper()'],
  ['loop binding', '    for helper in callbacks:\n        helper()'],
  ['import alias', '    import example as helper\n    return helper()'],
  ['from import alias', '    from example import (callback as helper)\n    return helper()'],
  ['context manager binding', '    with context() as helper:\n        helper()'],
  ['exception binding', '    try:\n        work()\n    except Exception as helper:\n        helper()'],
  ['assignment expression', '    if helper := callback:\n        helper()'],
  ['match capture', '    match value:\n        case {"callback": helper}:\n            helper()'],
  ['match alias', '    match value:\n        case [*items] as helper:\n            helper()'],
]) test(`Python ${label} shadows a global helper`, () => {
  const model = parse(`def helper():\n    return 1\n\ndef run():\n${body}\n`);
  assert.deepEqual(targets(symbol(model, 'run')), []);
  assert.ok(symbol(model, 'run').locals.has('helper'));
  assert.ok(symbol(model, 'run').calls.every(call => call.resolved === true));
});

test('comprehension bindings are local, while the first iterable uses the outer scope', () => {
  const model = parse(`def helper():
    return [1, 2]
def run():
    selected = [helper() for helper in helper()]
    return helper()
`), helper = symbol(model, 'helper'), calls = symbol(model, 'run').calls;
  assert.equal(calls.length, 3);
  assert.equal(calls[0].targetId, undefined);
  assert.equal(calls[1].targetId, helper.id);
  assert.equal(calls[2].targetId, helper.id);
  assert.equal(symbol(model, 'run').locals.has('helper'), false);
});

test('comprehension assignment expressions bind the enclosing function', () => {
  const model = parse(`def helper():
    return 1
def run(values):
    selected = [(helper := value) for value in values]
    return helper()
`);
  assert.deepEqual(targets(symbol(model, 'run')), []);
  assert.ok(symbol(model, 'run').locals.has('helper'));
});

test('nested functions resolve nonlocal helpers but uncertain global writes are not guessed', () => {
  const model = parse(`def helper():
    return 1
def outer():
    def local():
        return 2
    def inner():
        nonlocal local
        return local()
    return inner()
def change(callback):
    global helper
    helper = callback
    return helper()
`);
  assert.deepEqual(targets(symbol(model, 'outer.inner')), [symbol(model, 'outer.local').id]);
  assert.deepEqual(targets(symbol(model, 'change')), []);
});

test('rebound or duplicate function names remain unresolved rather than picking the last definition', () => {
  const model = parse(`def helper():
    return 1
def helper(value):
    return value
def run():
    return helper()
`);
  assert.deepEqual(targets(symbol(model, 'run')), []);
});

test('decorator and default calls execute in the enclosing scope, not the defined function body', () => {
  const model = parse(`def decorate(fn):
    return fn
def default():
    return 1
@decorate
def main(value=default()):
    return value
`), chunk = model.chunks.at(-1);
  assert.deepEqual(symbol(model, 'main').calls, []);
  assert.deepEqual(chunk.calls.map(call => call.targetId), [symbol(model, 'decorate').id, symbol(model, 'default').id]);
  assert.equal(chunk.calls[0].kind, 'decorator');
  assert.equal(chunk.startLine, 5);
});

test('conditional definitions and branch conditions remain visible for story explanations', () => {
  const model = parse(`if enabled:
    def choose(value):
        if value > 10:
            return "large"
        return "small"

choose(12)
`), choose = symbol(model, 'choose');
  assert.equal(choose.conditional, true);
  assert.deepEqual(choose.branches, [{type:'if', condition:'value > 10', line:3}]);
  assert.equal(model.chunks[0].symbolIds[0], choose.id);
  assert.ok(model.analysisNotes[0].includes('code is not executed'));
});

test('a lambda body is not treated as an immediate helper call', () => {
  const model = parse(`def helper():
    return 1
def run():
    callback = lambda: helper()
    return callback
`);
  assert.deepEqual(symbol(model, 'run').calls, []);
});

test('assigning over an instance method prevents a misleading method relationship', () => {
  const model = parse(`class Worker:
    def __init__(self, callback):
        self.helper = callback
    def helper(self):
        return 1
    def run(self):
        return self.helper()
`);
  assert.deepEqual(targets(symbol(model, 'Worker.run')), []);
});

test('explicit class method replacement and wildcard imports stay unresolved', () => {
  const replaced = parse(`class Worker:
    @staticmethod
    def helper():
        return 1
Worker.helper = callback
Worker.helper()
`);
  assert.equal(replaced.chunks.at(-1).calls[0].targetId, undefined);
  const imported = parse(`def helper():
    return 1
from callbacks import *
def run():
    return helper()
`);
  assert.deepEqual(targets(symbol(imported, 'run')), []);
});
