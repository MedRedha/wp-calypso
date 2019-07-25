/** @format */

/**
 * External dependencies
 */

import ReactDom from 'react-dom';
import React from 'react';
import { Provider as ReactReduxProvider, ReactReduxContext } from 'react-redux';

/**
 * Internal dependencies
 */
import { MomentProvider } from 'components/localized-moment/context';

export default class RootChild extends React.Component {
	reduxStore = null;

	setReduxStore = contextValue => {
		if ( contextValue ) {
			this.reduxStore = contextValue.store;
		}
	};

	componentDidMount() {
		this.container = document.createElement( 'div' );
		document.body.appendChild( this.container );
		this.renderChildren();
	}

	componentDidUpdate() {
		this.renderChildren();
	}

	componentWillUnmount() {
		if ( ! this.container ) {
			return;
		}

		ReactDom.unmountComponentAtNode( this.container );
		document.body.removeChild( this.container );
		delete this.container;
	}

	renderChildren() {
		let content;

		if ( this.props && ( Object.keys( this.props ).length > 1 || ! this.props.children ) ) {
			content = <div { ...this.props }>{ this.props.children }</div>;
		} else {
			content = this.props.children;
		}

		// Context is lost when creating a new render hierarchy, so ensure that
		// we preserve the context that we care about
		if ( this.reduxStore ) {
			content = (
				<ReactReduxProvider store={ this.reduxStore }>
					<MomentProvider>{ content }</MomentProvider>
				</ReactReduxProvider>
			);
		}

		ReactDom.render( content, this.container );
	}

	render() {
		return <ReactReduxContext.Consumer>{ this.setReduxStore }</ReactReduxContext.Consumer>;
	}
}
