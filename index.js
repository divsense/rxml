var fs = require("fs");
var R = require("ramda");
var State = require("momon").State;
var parser = require("./rxml.js");

// isTextNode :: node -> Boolean
var isTextNode = R.propEq('type','Text');
	
// isntTextNode :: node -> Boolean
var isntTextNode = R.compose( R.not, isTextNode );

// isTemplate :: [node] => Boolean
var isTemplate = R.pathEq([0,'name'], 'template');

// gtext :: [node] => [String]
var gtext = R.compose( R.map(R.prop('content')), R.filter( isTextNode ) );

// globals :: [node] => State([node], state)
var globals = ns => State.write(s => [R.filter( isntTextNode, ns ), R.over(R.lensProp('globals'), R.concat(gtext(ns)), s)]);

// content :: [node] => State([node], state)
var content = ns => {
	
	if( ns.length === 0 ){
		return State.of("end");
	}
	
	
	State.write( s => {
		var node = R.head( ns );
		var s_ = R.over( R.lensProp('fs'), R.append( "function 1" ), s);
		return [ R.tail( ns ), s_ ];
});

// addTemplate :: [node] => State([node], state)
var addTemplate = ns => State.write( s => {
		var node = R.head( ns );
		var s_ = R.over( R.lensProp('fs'), R.append( "function 1" ), s);
		return [ ns, s_ ];
});


// templates :: [node] => State([node], state)
var templates = ns => {
	if( ns.length === 0 ){
		return State.of("end");
	}

	if( ns[0].name === 'template' ){
		return R.composeK( templates, content, addTemplate)( State.of(ns) );
	}

	return templates( R.tail( ns ) );
}

var translate = R.composeK(templates, globals);

var input = fs.readFileSync("./test.html", {encoding: 'utf8'});
var model = parser.parse( input );

var res = translate( State.of(model) ).run({globals:[], statics:[], fs:[]});

console.log( res[1] );


//module.exports = function(opts){
//}

