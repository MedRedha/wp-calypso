/** @format */
/**
 * External dependencies
 */
import { connect } from 'react-redux';
import { flatten, filter, find, get, isEmpty, isEqual, reduce, startsWith } from 'lodash';
import i18n, { localize } from 'i18n-calypso';
import page from 'page';
import PropTypes from 'prop-types';
import React from 'react';
import { format as formatUrl, parse as parseUrl } from 'url';

/**
 * Internal dependencies
 */
import analytics from 'lib/analytics';
import { shouldShowTax, hasPendingPayment, getEnabledPaymentMethods } from 'lib/cart-values';
import {
	conciergeSessionItem,
	domainMapping,
	planItem as getCartItemForPlan,
	themeItem,
	hasGoogleApps,
	getGoogleApps,
	hasRenewalItem,
	getRenewalItemFromCartItem,
	getAllCartItems,
	getDomainRegistrations,
	getRenewalItems,
	hasFreeTrial,
	hasConciergeSession,
	hasDomainRegistration,
	hasJetpackPlan,
	hasBloggerPlan,
	hasPersonalPlan,
	hasPremiumPlan,
	hasPlan,
	hasOnlyRenewalItems,
	hasTransferProduct,
} from 'lib/cart-values/cart-items';
import PendingPaymentBlocker from './pending-payment-blocker';
import { clearSitePlans } from 'state/sites/plans/actions';
import { clearPurchases } from 'state/purchases/actions';
import DomainDetailsForm from './domain-details-form';
import { fetchReceiptCompleted } from 'state/receipts/actions';
import { getExitCheckoutUrl } from 'lib/checkout';
import { hasDomainDetails } from 'lib/store-transactions';
import notices from 'notices';
import { managePurchase } from 'me/purchases/paths';
import SubscriptionLengthPicker from 'blocks/subscription-length-picker';
import QueryContactDetailsCache from 'components/data/query-contact-details-cache';
import QueryStoredCards from 'components/data/query-stored-cards';
import QuerySitePlans from 'components/data/query-site-plans';
import QueryPlans from 'components/data/query-plans';
import SecurePaymentForm from './secure-payment-form';
import SecurePaymentFormPlaceholder from './secure-payment-form-placeholder';
import { AUTO_RENEWAL } from 'lib/url/support';
import {
	RECEIVED_WPCOM_RESPONSE,
	SUBMITTING_WPCOM_REQUEST,
} from 'lib/store-transactions/step-types';
import {
	addItem,
	replaceCartWithItems,
	replaceItem,
	applyCoupon,
	resetTransaction,
	setDomainDetails,
} from 'lib/upgrades/actions';
import getContactDetailsCache from 'state/selectors/get-contact-details-cache';
import getUpgradePlanSlugFromPath from 'state/selectors/get-upgrade-plan-slug-from-path';
import isDomainOnlySite from 'state/selectors/is-domain-only-site';
import isEligibleForSignupDestination from 'state/selectors/is-eligible-for-signup-destination';
import { getStoredCards } from 'state/stored-cards/selectors';
import { isValidFeatureKey } from 'lib/plans/features-list';
import { getPlan, findPlansKeys } from 'lib/plans';
import { GROUP_WPCOM } from 'lib/plans/constants';
import { recordViewCheckout } from 'lib/analytics/ad-tracking';
import { requestSite } from 'state/sites/actions';
import { isJetpackSite, isNewSite } from 'state/sites/selectors';
import { getSelectedSite, getSelectedSiteId, getSelectedSiteSlug } from 'state/ui/selectors';
import { getCurrentUserCountryCode } from 'state/current-user/selectors';
import { canDomainAddGSuite } from 'lib/gsuite';
import { getDomainNameFromReceiptOrCart } from 'lib/domains/cart-utils';
import { fetchSitesAndUser } from 'lib/signup/step-actions';
import { getProductsList, isProductsListFetching } from 'state/products-list/selectors';
import QueryProducts from 'components/data/query-products-list';
import { isRequestingSitePlans } from 'state/sites/plans/selectors';
import { isRequestingPlans } from 'state/plans/selectors';
import { isApplePayAvailable } from 'lib/web-payment';
import PageViewTracker from 'lib/analytics/page-view-tracker';
import isAtomicSite from 'state/selectors/is-site-automated-transfer';
import getPreviousPath from 'state/selectors/get-previous-path.js';
import config from 'config';
import { abtest } from 'lib/abtest';
import {
	persistSignupDestination,
	retrieveSignupDestination,
	clearSignupDestinationCookie,
} from 'signup/utils';
import { isExternal } from 'lib/url';

/**
 * Style dependencies
 */
import './style.scss';

export class Checkout extends React.Component {
	static propTypes = {
		cards: PropTypes.array.isRequired,
		couponCode: PropTypes.string,
		isJetpackNotAtomic: PropTypes.bool,
		selectedFeature: PropTypes.string,
	};

	state = {
		previousCart: null,
		cartSettled: false,
	};

	// TODO: update this component to not use deprecated life cycle methods
	/* eslint-disable-next-line react/no-deprecated */
	componentWillMount() {
		resetTransaction();
	}

	componentDidMount() {
		if ( this.redirectIfEmptyCart() ) {
			return;
		}

		if ( this.props.cart.hasLoadedFromServer ) {
			this.trackPageView();
		}

		if ( this.props.cart.hasLoadedFromServer && this.props.product ) {
			this.addProductToCart();
		} else if ( this.props.couponCode ) {
			applyCoupon( this.props.couponCode );
		}

		window.scrollTo( 0, 0 );
	}

	// TODO: update this component to not use deprecated life cycle methods
	/* eslint-disable-next-line react/no-deprecated */
	componentWillReceiveProps( nextProps ) {
		if ( ! this.props.cart.hasLoadedFromServer && nextProps.cart.hasLoadedFromServer ) {
			if ( this.props.product ) {
				this.addProductToCart();
			}

			this.trackPageView( nextProps );
		}

		if ( ! this.state.cartSettled && ! nextProps.cart.hasPendingServerUpdates ) {
			this.setState( {
				cartSettled: true,
			} );
		}
	}

	componentDidUpdate() {
		if ( ! this.props.cart.hasLoadedFromServer ) {
			return false;
		}

		const previousCart = this.state.previousCart;
		const nextCart = this.props.cart;

		if ( ! isEqual( previousCart, nextCart ) ) {
			this.redirectIfEmptyCart();
			// TODO: rewrite state management so we don't have to call setState here
			/* eslint-disable-next-line react/no-did-update-set-state */
			this.setState( { previousCart: nextCart } );
		}

		if (
			this.props.isNewlyCreatedSite &&
			this.props.contactDetails &&
			hasGoogleApps( this.props.cart ) &&
			this.needsDomainDetails()
		) {
			this.setDomainDetailsForGSuiteCart();
		}
	}

	setDomainDetailsForGSuiteCart() {
		const { contactDetails, cart } = this.props;
		const domainReceiptId = get( getGoogleApps( cart ), '[0].extra.receipt_for_domain', 0 );

		if ( domainReceiptId ) {
			setDomainDetails( contactDetails );
		}
	}

	trackPageView( props ) {
		props = props || this.props;

		analytics.tracks.recordEvent( 'calypso_checkout_page_view', {
			saved_cards: props.cards.length,
			is_renewal: hasRenewalItem( props.cart ),
			apple_pay_available: isApplePayAvailable(),
		} );

		recordViewCheckout( props.cart );
	}

	getPlanProducts() {
		return this.props.cart.products.filter( ( { product_slug } ) => getPlan( product_slug ) );
	}

	getProductSlugFromSynonym( slug ) {
		if ( 'no-ads' === slug ) {
			return 'no-adverts/no-adverts.php';
		}
		return slug;
	}

	addProductToCart() {
		if ( this.props.purchaseId ) {
			this.addRenewItemsToCart();
		} else {
			this.addNewItemToCart();
		}
		if ( this.props.couponCode ) {
			applyCoupon( this.props.couponCode );
		}
	}

	addRenewItemsToCart() {
		const { product, purchaseId, selectedSiteSlug } = this.props;
		// products can sometimes contain multiple items separated by commas
		const products = product.split( ',' );

		if ( ! purchaseId ) {
			return;
		}

		// purchaseId can sometimes contain multiple items separated by commas
		const purchaseIds = purchaseId.split( ',' );

		const itemsToAdd = purchaseIds
			.map( ( subscriptionId, currentIndex ) => {
				const productSlug = products[ currentIndex ];
				if ( ! productSlug ) {
					return null;
				}
				return this.getRenewalItemForProductAndSubscription(
					productSlug,
					subscriptionId,
					selectedSiteSlug
				);
			} )
			.filter( item => item );
		replaceCartWithItems( itemsToAdd );
	}

	getRenewalItemForProductAndSubscription( product, purchaseId, selectedSiteSlug ) {
		const [ slug, meta ] = product.split( ':' );
		const productSlug = this.getProductSlugFromSynonym( slug );

		if ( ! purchaseId ) {
			return;
		}

		const cartItem = getRenewalItemFromCartItem(
			{
				meta,
				product_slug: productSlug,
			},
			{
				id: purchaseId,
				domain: selectedSiteSlug,
			}
		);

		return cartItem;
	}

	addNewItemToCart() {
		const { planSlug, cart } = this.props;

		let cartItem, cartMeta;

		if ( planSlug ) {
			cartItem = getCartItemForPlan( planSlug );
		}

		if ( startsWith( this.props.product, 'theme' ) ) {
			cartMeta = this.props.product.split( ':' )[ 1 ];
			cartItem = themeItem( cartMeta );
		}

		if ( startsWith( this.props.product, 'domain-mapping' ) ) {
			cartMeta = this.props.product.split( ':' )[ 1 ];
			cartItem = domainMapping( { domain: cartMeta } );
		}

		if ( startsWith( this.props.product, 'concierge-session' ) ) {
			cartItem = ! hasConciergeSession( cart ) && conciergeSessionItem();
		}

		if ( cartItem ) {
			addItem( cartItem );
		}
	}

	redirectIfEmptyCart() {
		const { selectedSiteSlug, transaction } = this.props;

		if ( ! transaction ) {
			return true;
		}

		if ( ! this.state.previousCart && this.props.product ) {
			// the plan hasn't been added to the cart yet
			return false;
		}

		if (
			! this.props.cart.hasLoadedFromServer ||
			! isEmpty( getAllCartItems( this.props.cart ) )
		) {
			return false;
		}

		if ( SUBMITTING_WPCOM_REQUEST === transaction.step.name ) {
			return false;
		}

		if ( RECEIVED_WPCOM_RESPONSE === transaction.step.name && isEmpty( transaction.errors ) ) {
			// If the cart is emptied by the server after the transaction is
			// complete without errors, do not redirect as we're waiting for
			// some post-transaction requests to complete.
			return false;
		}

		let redirectTo = '/plans/';

		if ( this.state.previousCart ) {
			redirectTo = getExitCheckoutUrl( this.state.previousCart, selectedSiteSlug );
		}

		page.redirect( redirectTo );

		return true;
	}

	/**
	 * Purchases are of the format { [siteId]: [ { productId: ... } ] }
	 * so we need to flatten them to get a list of purchases
	 *
	 * @param {Object} purchases keyed by siteId { [siteId]: [ { productId: ... } ] }
	 * @returns {Array} of product objects [ { productId: ... }, ... ]
	 */
	flattenPurchases( purchases ) {
		return flatten( Object.values( purchases ) );
	}

	getEligibleDomainFromCart() {
		const domainRegistrations = getDomainRegistrations( this.props.cart );
		const domainsInSignupContext = filter( domainRegistrations, { extra: { context: 'signup' } } );
		const domainsForGSuite = filter( domainsInSignupContext, ( { meta } ) =>
			canDomainAddGSuite( meta )
		);

		return domainsForGSuite;
	}

	maybeShowPlanUpgradeOffer( receiptId ) {
		const { cart, selectedSiteSlug } = this.props;

		if ( hasPersonalPlan( cart ) ) {
			if ( 'variantShowNudge' === abtest( 'showPlanUpsellNudge' ) ) {
				return `/checkout/${ selectedSiteSlug }/offer-plan-upgrade/premium/${ receiptId }`;
			}
		}

		return;
	}

	getCheckoutCompleteRedirectPath = () => {
		// TODO: Cleanup and simplify this function.
		// I wouldn't be surprised if it doesn't work as intended in some scenarios.
		// Especially around the G Suite / Concierge / Checklist logic.

		let renewalItem, displayModeParam;
		const {
			cart,
			redirectTo,
			selectedSite,
			selectedSiteSlug,
			previousRoute,
			transaction: { step: { data: stepResult = null } = {} } = {},
		} = this.props;
		const domainReceiptId = get( getGoogleApps( cart ), '[0].extra.receipt_for_domain', 0 );

		const adminUrl = get( selectedSite, [ 'options', 'admin_url' ] );

		// If we're given an explicit `redirectTo` query arg, make sure it's either internal
		// (i.e. on WordPress.com), or a Jetpack or WP.com site's block editor (in wp-admin).
		// This is required for Jetpack's (and WP.com's) paid blocks Upgrade Nudge.
		if ( redirectTo ) {
			if ( ! isExternal( redirectTo ) ) {
				return redirectTo;
			}

			const { protocol, hostname, port, pathname, query } = parseUrl( redirectTo, true, true );

			// We cannot simply compare `hostname` to `selectedSiteSlug`, since the latter
			// might contain a path in the case of Jetpack subdirectory installs.
			if ( adminUrl && redirectTo.startsWith( `${ adminUrl }post.php?` ) ) {
				const sanitizedRedirectTo = formatUrl( {
					protocol,
					hostname,
					port,
					pathname,
					query: {
						post: parseInt( get( query, [ 'post' ] ), 10 ),
						action: 'edit',
					},
				} );
				return sanitizedRedirectTo;
			}
		}

		// Note: this function is called early on for redirect-type payment methods, when the receipt isn't set yet.
		// The `:receiptId` string is filled in by our callback page after the PayPal checkout
		let pendingOrReceiptId;

		if ( get( stepResult, 'receipt_id', false ) ) {
			pendingOrReceiptId = stepResult.receipt_id;
		} else if ( get( stepResult, 'orderId', false ) ) {
			pendingOrReceiptId = 'pending/' + stepResult.orderId;
		} else {
			pendingOrReceiptId = this.props.purchaseId ? this.props.purchaseId : ':receiptId';
		}

		const signupDestination = retrieveSignupDestination() || `/`;

		persistSignupDestination( signupDestination );

		if ( hasRenewalItem( cart ) ) {
			renewalItem = getRenewalItems( cart )[ 0 ];

			return managePurchase( renewalItem.extra.purchaseDomain, renewalItem.extra.purchaseId );
		}

		if ( hasFreeTrial( cart ) ) {
			return selectedSiteSlug
				? `/plans/${ selectedSiteSlug }/thank-you`
				: '/checkout/thank-you/plans';
		}

		if ( cart.create_new_blog ) {
			return `${ signupDestination }/${ pendingOrReceiptId }`;
		}

		if ( ! selectedSiteSlug ) {
			return '/checkout/thank-you/features';
		}

		// If cart is empty, then send the user to a generic page (not post-purchase related).
		// For example, this case arises when a Skip button is clicked on a concierge upsell
		// nudge opened by a direct link to /offer-support-session.
		if (
			':receiptId' === pendingOrReceiptId &&
			isEmpty( getAllCartItems( cart ) ) &&
			! previousRoute.includes( '/checkout' )
		) {
			return `/stats/day/${ selectedSiteSlug }`;
		}

		if ( this.props.isJetpackNotAtomic ) {
			// @FIXME temporary fix for plans purcahsed via `/plans` or WP Admin for connected sites
			// @see https://github.com/Automattic/wp-calypso/issues/35068
			// Do not use the fallback `/` route after checkout
			if ( selectedSiteSlug && signupDestination === '/' ) {
				// Matches route from client/my-sites/checkout/checkout-thank-you/index.jsx:445
				return `/plans/my-plan/${ selectedSiteSlug }?thank-you`;
			}
			return signupDestination;
		}

		if ( this.props.isNewlyCreatedSite && stepResult && isEmpty( stepResult.failed_purchases ) ) {
			const siteDesignType = get( selectedSite, 'options.design_type' );
			const hasGoogleAppsInCart = hasGoogleApps( cart );

			// Handle the redirect path after a purchase of GSuite
			// The onboarding checklist currently supports the blog type only.
			if ( hasGoogleAppsInCart && domainReceiptId && 'store' !== siteDesignType ) {
				analytics.tracks.recordEvent( 'calypso_checklist_assign', {
					site: selectedSiteSlug,
					plan: 'paid',
				} );

				return `${ signupDestination }?d=gsuite`;
			}

			// Maybe show either the G Suite or Concierge Session upsell pages
			if (
				! hasGoogleAppsInCart &&
				! hasConciergeSession( cart ) &&
				hasDomainRegistration( cart )
			) {
				const domainsForGSuite = this.getEligibleDomainFromCart();
				if ( domainsForGSuite.length ) {
					return (
						this.maybeShowPlanUpgradeOffer( pendingOrReceiptId ) ||
						`/checkout/${ selectedSiteSlug }/with-gsuite/${
							domainsForGSuite[ 0 ].meta
						}/${ pendingOrReceiptId }`
					);
				}
			}
		}

		// For a user purchasing a qualifying plan, show either a plan upgrade upsell or concierge upsell.
		// This tests the flow that was not eligible for G Suite.
		// If the user has upgraded a plan from seeing our upsell(we find this by checking the previous route is /offer-plan-upgrade),
		// then skip this section so that we do not show further upsells.
		if (
			config.isEnabled( 'upsell/concierge-session' ) &&
			! hasConciergeSession( cart ) &&
			! hasJetpackPlan( cart ) &&
			( hasBloggerPlan( cart ) || hasPersonalPlan( cart ) || hasPremiumPlan( cart ) ) &&
			! previousRoute.includes( `/checkout/${ selectedSiteSlug }/offer-plan-upgrade` )
		) {
			const upgradePath = this.maybeShowPlanUpgradeOffer( pendingOrReceiptId );
			if ( upgradePath ) {
				return upgradePath;
			}

			// A user just purchased one of the qualifying plans
			// Show them the concierge session upsell page
			if ( 'offer' === abtest( 'conciergeUpsellDial' ) ) {
				return `/checkout/${ selectedSiteSlug }/offer-quickstart-session/${ pendingOrReceiptId }`;
			}
		}

		if ( hasConciergeSession( cart ) ) {
			displayModeParam = 'd=concierge';
		}

		const queryParam = displayModeParam ? `?${ displayModeParam }` : '';

		if ( ':receiptId' !== pendingOrReceiptId && this.props.isEligibleForSignupDestination ) {
			return `${ signupDestination }${ queryParam }`;
		}

		return this.props.selectedFeature && isValidFeatureKey( this.props.selectedFeature )
			? `/checkout/thank-you/features/${
					this.props.selectedFeature
			  }/${ selectedSiteSlug }/${ pendingOrReceiptId }`
			: `/checkout/thank-you/${ selectedSiteSlug }/${ pendingOrReceiptId }${ queryParam }`;
	};

	handleCheckoutExternalRedirect( redirectUrl ) {
		window.location.href = redirectUrl;
	}

	handleCheckoutCompleteRedirect = () => {
		let product, purchasedProducts, renewalItem;

		const {
			cart,
			isDomainOnly,
			reduxStore,
			selectedSiteId,
			transaction: { step: { data: receipt = null } = {} } = {},
			translate,
		} = this.props;

		const redirectPath = this.getCheckoutCompleteRedirectPath();
		const destinationFromCookie = retrieveSignupDestination();

		this.props.clearPurchases();

		// Removes the destination cookie only if redirecting to the signup destination.
		// (e.g. if the destination is an upsell nudge, it does not remove the cookie).
		if ( redirectPath.includes( destinationFromCookie ) ) {
			clearSignupDestinationCookie();
		}

		if ( hasRenewalItem( cart ) ) {
			// checkouts for renewals redirect back to `/purchases` with a notice

			renewalItem = getRenewalItems( cart )[ 0 ];
			// group all purchases into an array
			purchasedProducts = reduce(
				( receipt && receipt.purchases ) || {},
				function( result, value ) {
					return result.concat( value );
				},
				[]
			);
			// and take the first product which matches the product id of the renewalItem
			product = find( purchasedProducts, function( item ) {
				return item.product_id === renewalItem.product_id;
			} );

			if ( product && product.will_auto_renew ) {
				notices.success(
					translate(
						'%(productName)s has been renewed and will now auto renew in the future. ' +
							'{{a}}Learn more{{/a}}',
						{
							args: {
								productName: renewalItem.product_name,
							},
							components: {
								a: <a href={ AUTO_RENEWAL } target="_blank" rel="noopener noreferrer" />,
							},
						}
					),
					{ persistent: true }
				);
			} else if ( product ) {
				notices.success(
					translate(
						'Success! You renewed %(productName)s for %(duration)s, until %(date)s. ' +
							'We sent your receipt to %(email)s.',
						{
							args: {
								productName: renewalItem.product_name,
								duration: i18n.moment.duration( { days: renewalItem.bill_period } ).humanize(),
								date: i18n.moment( product.expiry ).format( 'LL' ),
								email: product.user_email,
							},
						}
					),
					{ persistent: true }
				);
			}
		} else if ( hasFreeTrial( cart ) ) {
			this.props.clearSitePlans( selectedSiteId );
		}

		if ( receipt && receipt.receipt_id ) {
			const receiptId = receipt.receipt_id;

			this.props.fetchReceiptCompleted( receiptId, {
				...receipt,
				purchases: this.flattenPurchases( this.props.transaction.step.data.purchases ),
				failedPurchases: this.flattenPurchases( this.props.transaction.step.data.failed_purchases ),
			} );
		}

		if ( selectedSiteId ) {
			this.props.requestSite( selectedSiteId );
		}

		this.props.setHeaderText( '' );

		if (
			( cart.create_new_blog && receipt && isEmpty( receipt.failed_purchases ) ) ||
			( isDomainOnly && hasPlan( cart ) && ! selectedSiteId )
		) {
			notices.info( translate( 'Almost done…' ) );

			const domainName = getDomainNameFromReceiptOrCart( receipt, cart );

			if ( domainName ) {
				fetchSitesAndUser(
					domainName,
					() => {
						page( redirectPath );
					},
					reduxStore
				);

				return;
			}
		}

		page( redirectPath );
	};

	content() {
		const {
			selectedSite,
			transaction,
			cart,
			cards,
			productsList,
			setHeaderText,
			userCountryCode,
		} = this.props;

		if ( this.isLoading() ) {
			return <SecurePaymentFormPlaceholder />;
		}

		if ( config.isEnabled( 'async-payments' ) && hasPendingPayment( this.props.cart ) ) {
			return <PendingPaymentBlocker />;
		}

		if ( this.needsDomainDetails() ) {
			return (
				<DomainDetailsForm
					cart={ cart }
					productsList={ productsList }
					userCountryCode={ userCountryCode }
				/>
			);
		}

		return (
			<SecurePaymentForm
				cart={ cart }
				transaction={ transaction }
				cards={ cards }
				paymentMethods={ this.paymentMethodsAbTestFilter() }
				products={ productsList }
				selectedSite={ selectedSite }
				setHeaderText={ setHeaderText }
				redirectTo={ this.getCheckoutCompleteRedirectPath }
				handleCheckoutCompleteRedirect={ this.handleCheckoutCompleteRedirect }
				handleCheckoutExternalRedirect={ this.handleCheckoutExternalRedirect }
			>
				{ this.renderSubscriptionLengthPicker() }
			</SecurePaymentForm>
		);
	}

	renderSubscriptionLengthPicker() {
		const planInCart = this.getPlanProducts()[ 0 ];
		if ( ! planInCart ) {
			return false;
		}

		const currentPlanSlug = this.props.selectedSite.plan.product_slug;
		const chosenPlan = getPlan( planInCart.product_slug );

		// Only render this for WP.com plans
		if ( chosenPlan.group !== GROUP_WPCOM ) {
			return false;
		}

		// Don't render when we're renewing a plan. Stick with the current period.
		if ( planInCart.product_slug === currentPlanSlug ) {
			return false;
		}

		const availableTerms = findPlansKeys( {
			group: chosenPlan.group,
			type: chosenPlan.type,
		} ).filter( planSlug => getPlan( planSlug ).availableFor( currentPlanSlug ) );

		if ( availableTerms.length < 2 ) {
			return false;
		}

		return (
			<React.Fragment>
				<SubscriptionLengthPicker
					cart={ this.props.cart }
					plans={ availableTerms }
					initialValue={ planInCart.product_slug }
					onChange={ this.handleTermChange }
					shouldShowTax={ shouldShowTax( this.props.cart ) }
					key="picker"
				/>
				<hr className="checkout__subscription-length-picker-separator" key="separator" />
			</React.Fragment>
		);
	}

	handleTermChange = ( { value: planSlug } ) => {
		const product = this.getPlanProducts()[ 0 ];
		const cartItem = getCartItemForPlan( planSlug, {
			domainToBundle: get( product, 'extra.domain_to_bundle', '' ),
		} );
		analytics.tracks.recordEvent( 'calypso_signup_plan_select', {
			product_slug: cartItem.product_slug,
			free_trial: cartItem.free_trial,
			from_section: 'checkout',
		} );
		replaceItem( product, cartItem );
	};

	paymentMethodsAbTestFilter() {
		// This methods can be used to filter payment methods
		// For example, for the purpose of AB tests.
		return getEnabledPaymentMethods( this.props.cart );
	}

	isLoading() {
		const isLoadingCart = ! this.props.cart.hasLoadedFromServer;
		const isLoadingProducts = this.props.isProductsListFetching;
		const isLoadingPlans = this.props.isPlansListFetching;
		const isLoadingSitePlans = this.props.isSitePlansListFetching;
		const isCartSettled = this.state.cartSettled;

		return (
			isLoadingCart || isLoadingProducts || isLoadingPlans || isLoadingSitePlans || ! isCartSettled
		);
	}

	needsDomainDetails() {
		const cart = this.props.cart;
		const transaction = this.props.transaction;

		if ( cart && hasOnlyRenewalItems( cart ) ) {
			return false;
		}

		return (
			cart &&
			transaction &&
			! hasDomainDetails( transaction ) &&
			( hasDomainRegistration( cart ) || hasGoogleApps( cart ) || hasTransferProduct( cart ) )
		);
	}

	render() {
		const { plan, product, purchaseId, selectedFeature, selectedSiteSlug } = this.props;
		let analyticsPath = '';
		let analyticsProps = {};
		if ( purchaseId && product ) {
			analyticsPath = '/checkout/:product/renew/:purchase_id/:site';
			analyticsProps = { product, purchase_id: purchaseId, site: selectedSiteSlug };
		} else if ( selectedFeature && plan ) {
			analyticsPath = '/checkout/features/:feature/:site/:plan';
			analyticsProps = { feature: selectedFeature, plan, site: selectedSiteSlug };
		} else if ( selectedFeature && ! plan ) {
			analyticsPath = '/checkout/features/:feature/:site';
			analyticsProps = { feature: selectedFeature, site: selectedSiteSlug };
		} else if ( product && ! purchaseId ) {
			analyticsPath = '/checkout/:site/:product';
			analyticsProps = { product, site: selectedSiteSlug };
		} else if ( selectedSiteSlug ) {
			analyticsPath = '/checkout/:site';
			analyticsProps = { site: selectedSiteSlug };
		} else {
			analyticsPath = '/checkout/no-site';
		}

		if ( this.props.children ) {
			this.props.setHeaderText( '' );
			return React.Children.map( this.props.children, child => {
				return React.cloneElement( child, {
					handleCheckoutCompleteRedirect: this.handleCheckoutCompleteRedirect,
				} );
			} );
		}

		/* eslint-disable wpcalypso/jsx-classname-namespace */
		return (
			<div className="main main-column" role="main">
				<div className="checkout">
					<QuerySitePlans siteId={ this.props.selectedSiteId } />
					<QueryPlans />
					<QueryProducts />
					<QueryContactDetailsCache />
					<QueryStoredCards />

					<PageViewTracker path={ analyticsPath } title="Checkout" properties={ analyticsProps } />

					{ this.content() }
				</div>
			</div>
		);
		/* eslint-enable wpcalypso/jsx-classname-namespace */
	}
}

export default connect(
	( state, props ) => {
		const selectedSiteId = getSelectedSiteId( state );

		return {
			cards: getStoredCards( state ),
			isDomainOnly: isDomainOnlySite( state, selectedSiteId ),
			selectedSite: getSelectedSite( state ),
			selectedSiteId,
			selectedSiteSlug: getSelectedSiteSlug( state ),
			isNewlyCreatedSite: isNewSite( state, selectedSiteId ),
			contactDetails: getContactDetailsCache( state ),
			userCountryCode: getCurrentUserCountryCode( state ),
			isEligibleForSignupDestination: isEligibleForSignupDestination(
				state,
				selectedSiteId,
				props.cart
			),
			productsList: getProductsList( state ),
			isProductsListFetching: isProductsListFetching( state ),
			isPlansListFetching: isRequestingPlans( state ),
			isSitePlansListFetching: isRequestingSitePlans( state, selectedSiteId ),
			planSlug: getUpgradePlanSlugFromPath( state, selectedSiteId, props.product ),
			previousRoute: getPreviousPath( state ),
			isJetpackNotAtomic:
				isJetpackSite( state, selectedSiteId ) && ! isAtomicSite( state, selectedSiteId ),
		};
	},
	{
		clearPurchases,
		clearSitePlans,
		fetchReceiptCompleted,
		requestSite,
	}
)( localize( Checkout ) );
