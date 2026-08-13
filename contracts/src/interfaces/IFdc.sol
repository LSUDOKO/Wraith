// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

/// @notice The subset of Flare's FDC interfaces Wraith needs, transcribed from
/// `flare-smart-contracts-v2` (`contracts/userInterfaces/fdc/`).
///
/// These are declared locally rather than pulled from
/// `@flarenetwork/flare-periphery-contracts` on purpose: the structs are
/// consensus-critical calldata layouts, and vendoring exactly the two
/// attestation types Wraith consumes keeps the dependency surface — and the
/// audit surface — to what is actually used. Field order and types must match
/// the upstream interfaces byte for byte or the external call will decode
/// garbage.

/// @notice Payment attestation (`0x01`) — a native-currency transfer on an
/// external chain. Wraith uses this for XRPL triggers.
interface IPayment {
    struct RequestBody {
        bytes32 transactionId;
        uint256 inUtxo;
        uint256 utxo;
    }

    struct ResponseBody {
        uint64 blockNumber;
        uint64 blockTimestamp;
        bytes32 sourceAddressHash;
        bytes32 sourceAddressesRoot;
        bytes32 receivingAddressHash;
        bytes32 intendedReceivingAddressHash;
        int256 spentAmount;
        int256 intendedSpentAmount;
        int256 receivedAmount;
        int256 intendedReceivedAmount;
        bytes32 standardPaymentReference;
        bool oneToOne;
        uint8 status;
    }

    struct Response {
        bytes32 attestationType;
        bytes32 sourceId;
        uint64 votingRound;
        uint64 lowestUsedTimestamp;
        RequestBody requestBody;
        ResponseBody responseBody;
    }

    struct Proof {
        bytes32[] merkleProof;
        Response data;
    }
}

/// @notice Web2Json attestation — an attested, jq-post-processed HTTP response.
/// Wraith uses this as the second oracle in a consensus order.
interface IWeb2Json {
    struct RequestBody {
        string url;
        string httpMethod;
        string headers;
        string queryParams;
        string body;
        string postProcessJq;
        string abiSignature;
    }

    struct ResponseBody {
        bytes abiEncodedData;
    }

    struct Response {
        bytes32 attestationType;
        bytes32 sourceId;
        uint64 votingRound;
        uint64 lowestUsedTimestamp;
        RequestBody requestBody;
        ResponseBody responseBody;
    }

    struct Proof {
        bytes32[] merkleProof;
        Response data;
    }
}

/// @notice On-chain verifier for FDC attestations. Resolved from the Flare
/// contract registry under the name `FdcVerification`.
interface IFdcVerification {
    function verifyPayment(IPayment.Proof calldata _proof) external view returns (bool);
    function verifyWeb2Json(IWeb2Json.Proof calldata _proof) external view returns (bool);
}
